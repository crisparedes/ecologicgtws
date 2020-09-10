const express = require('express');
const cheerio = require('cheerio');
const request = require('request');
const phantom = require('phantom');
const fs = require('fs').promises;
const app = express();
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");

const urlGuatecompras = 'http://www.guatecompras.gt';


var serviceAccount = require("./permissions.json");
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://ecologicgt-bc054.firebaseio.com"
});

const db = admin.database();

let productos = [];
let adjudicaciones = [];

//información de firebase para comparar
var productosFirebase = [];
var adjudicacionesFirebase = [];

let error = false;
let errores = [];

let nogProductosFaltantes = [];
let nogAdjudicacionesFaltantes = [];

//exportando la carpeta que contiene los assets y css
app.use(express.static('public'));

app.listen(process.env.PORT || 5000, () => {
    console.log('Servidor iniciado');
});

//empieza todo el webscraping a guatecompras
app.get('/wscore', function (req, res) {
    console.log('Procesar core');
    proceso();
    res.send('Terminado');
});

//empieza todo el webscraping a productos
app.get('/wsproductos', function (req, res) {
    /* console.log('Procesar productos');
     productos = [];
     // procesoProductos();
     console.log('Procesar productos terminado');*/
    res.send('Terminado');
});


//empieza todo el webscraping a adjudicaciones
app.get('/wsadjudicaciones', function (req, res) {
    console.log('Procesar adjudicaciones');
    adjudicaciones = [];
    //procesoAdjudicaciones();
    res.send('Terminado');
});

/* -----------------------------proceso principal------------------------------------ */
async function proceso() {
    console.log('Proceso iniciado');
    productosFirebase = [];
    adjudicacionesFirebase = [];
    nogProductosFaltantes = [];
    nogAdjudicacionesFaltantes = [];
    getProductosFirebase();
    getAdjudicacionesFirebase();
    error = false;
    let pgGuatecompras = await obtenerHTML(urlGuatecompras + '/Compradores/consultaDetEnt.aspx?iEnt=16&iUnt=0&iTipo=4');
    let concursosPublicados = [];
    let infoEntidad;

    if (!pgGuatecompras.err && pgGuatecompras.res.statusCode == 200) {
        try {
            //obtener el html de la pagina principal
            let $ = cheerio.load(pgGuatecompras.body);

            //obtener información del Ministerio de ambiente y recursos naturales

            infoEntidad = getInfoEntidad($);
            console.log(infoEntidad);

            //obtener la tabla principal
            let tablaAnual = $('#MasterGC_ContentBlockHolder_dbResumen');
            let filas = tablaAnual.find('tr');
            for (var i = 2; i < filas.length - 1; i++) {
                let columnas = filas.eq(i).find('td');
                let link;
                for (var j = 1; j < columnas.length - 2; j++) {
                    if (columnas.eq(j).find('a').attr('href')) {
                        link = columnas.eq(j).find('a').attr('href')
                    } else {
                        link = '-';
                    }

                    let valor = columnas.eq(j).text();

                    let periodo = columnas.eq(0).text();
                    let categoria = filas.eq(1).find('td').eq(j).text();

                    if (parseInt(periodo) > 2009) {
                        concursosPublicados.push({ periodo: periodo, categoria: categoria, valor: valor.trim(), link: link, concursos: [] });
                    }
                }
            }

            if (concursosPublicados.length == 0) {
                error = true;
                errores.push({ metodo: 'proceso', mensaje: 'Hubo algun error porque no hay concursos' });
            }
        } catch (e) {
            console.log("error:", e);
            error = true;
            errores.push({ metodo: 'proceso', mensaje: e });
            return;
        }
    } else if (pgGuatecompras.err) {

        console.log("error:", pgGuatecompras.err);
        error = true;
        errores.push({ metodo: 'proceso', mensaje: pgGuatecompras.err });
    }
    //procesar los concursos publicados
    await procesarConcursos(concursosPublicados);

    if (error) { //validar si hubo error mandar el log por email al administrador
        fs.writeFile('errores.json', JSON.stringify(errores), function (err) {
            if (err) return console.log(err);
            console.log('errores > errores.json');
        });
        await sendEmail();
    } else {
        //guardar los concursos en un archivo como respaldo y subirlos a la base de datos
        fs.writeFile('concursosPublicados.json', JSON.stringify(concursosPublicados), function (err) {
            if (err) return console.log(err);
            console.log('concursosPublicados > concursosPublicados.json');
        });

        var ref = db.ref("Concursos");
        ref.remove();
        sleep(10000);
        ref.push(concursosPublicados);

        var refInfo = db.ref("infoEntidad");
        refInfo.remove();
        sleep(10000);
        refInfo.push(infoEntidad);
    }


    if (nogProductosFaltantes.length > 0 && nogAdjudicacionesFaltantes > 0) {
        await sendEmail2(nogProductosFaltantes,nogAdjudicacionesFaltantes);
    }

    //guardar los productos faltantes
    fs.writeFile('nogProductosFaltantes.json', JSON.stringify(nogProductosFaltantes), function (err) {
        if (err) return console.log(err);
        console.log('nogProductosFaltantes > nogProductosFaltantes.json');
    });

    //guardar las adjudicaciones faltantes
    fs.writeFile('nogAdjudicacionesFaltantes.json', JSON.stringify(nogAdjudicacionesFaltantes), function (err) {
        if (err) return console.log(err);
        console.log('nogAdjudicacionesFaltantes > nogAdjudicacionesFaltantes.json');
    });

    /* fs.writeFile('adjudicacionesProcesar.json', JSON.stringify(adjudicaciones), function (err) {
         if (err) return console.log(err);
         console.log('adjudicacionesProcesar > adjudicacionesProcesar.json');
     });*/
    console.log('Proceso finalizado');
}

/* -----------------------------proceso de adjudicaciones------------------------------------ */
async function procesarConcursos(concursosPublicados) {

    console.log('Procesando concursos');
    for (let x = 0; x < concursosPublicados.length; x++) {
        item = concursosPublicados[x];
        //console.log(item);
        if (item.link != '-') {
            let pgGuatecompras = await obtenerHTML(urlGuatecompras + item.link);
            let concursos = [];
            if (!pgGuatecompras.err && pgGuatecompras.res.statusCode == 200) {
                //obtener el html de la pagina
                let $ = cheerio.load(pgGuatecompras.body);

                //obtener los hrefs de paginación
                let tablaCategoria = $('#MasterGC_ContentBlockHolder_dgResultado');
                let filas = tablaCategoria.find('tr');

                let linksConcursos = [];
                //obtener los links de la primera pagina
                for (var i = 1; i < filas.length - 1; i++) {
                    let columnas = filas.eq(i).find('td');
                    linksConcursos.push(columnas.eq(1).find('a').attr('href'));
                }

                //si hay pagineo entonces hay que ir a cargar esas paginas con phantomjs
                let columna = filas.eq(filas.length - 1).find('td');
                let hrefsPagineo = columna.eq(0).find('a');

                console.log('hrefs ' + hrefsPagineo.length);

                for (var i = 0; i < hrefsPagineo.length; i++) {
                    let doPostBack = hrefsPagineo.eq(i).attr('href').replace("javascript:__doPostBack('", '').replace("','')", '');
                    console.log("pagineo ", doPostBack);
                    let linksConcursosPagineo = await getConcursosPagineo(urlGuatecompras + item.link, doPostBack);
                    console.log("pagineo concursos" + linksConcursosPagineo.length);
                    Array.prototype.push.apply(linksConcursos, linksConcursosPagineo);
                }

                console.log("concursos: " + linksConcursos.length)

                console.log(linksConcursos);
                for (var i = 0; i < linksConcursos.length; i++) {
                    let linkConcurso = linksConcursos[i];

                    let pgConcurso = await obtenerHTML(urlGuatecompras + linkConcurso);

                    let bodyConcurso = cheerio.load(pgConcurso.body);

                    let divNombre = bodyConcurso("div[class='col-xs-12 col-md-3 EtiquetaForm3']")
                    let divInfo = bodyConcurso("div[class='col-xs-12 col-md-9 EtiquetaInfo']");


                    let atributos = [];
                    for (let x = 0; x < divNombre.length; x++) {
                        //console.log(divNombre.eq(x).text().trim().toString().replace(/\s/g, '')+" : "+divInfo.eq(x).text().trim());
                        atributos.push([divNombre.eq(x).text().trim().toString().replace(/\s/g, ''), divInfo.eq(x).text().trim()]);
                    }
                    atributos.push(['link', urlGuatecompras + linkConcurso]);

                    //validadndo si el concurso ya tiene productos y adjudicaciones
                    let idConcurso = divInfo.eq(0).text().trim();

                    if (item.categoria.toString() == 'Terminados Adjudicados' && !adjudicacionesFirebase.includes(idConcurso)) {
                        console.log("obteniendo adjudicaciones " + idConcurso);
                        await getAdjudicaciones({ link: urlGuatecompras + linkConcurso, nog: idConcurso });
                    }

                    if (!productosFirebase.includes(idConcurso)) {
                        console.log("obteniendo productos " + idConcurso);
                        await getTipoProductos({ link: urlGuatecompras + linkConcurso, nog: idConcurso });
                    }
                    //let productos = await getTipoProductos(urlGuatecompras + linkConcurso);

                    /*  //guardar los productos en un array de objetos para luego consultarlos
                      productos.push({ link: urlGuatecompras + linkConcurso, nog: divInfo.eq(0).text().trim() });

                      //guardar los ofertantes en un array de objetos para luego consultarlos En Evaluación, Terminados Adjudicados, Finalizados Desiertos

                      if (item.categoria.toString() == 'Terminados Adjudicados') {
                          adjudicaciones.push({ link: urlGuatecompras + linkConcurso, nog: divInfo.eq(0).text().trim() });
                      }*/


                    //información de concurso
                    let infoConcurso = {
                        nog: divInfo.eq(0).text().trim(),
                        atributos: atributos
                    }
                    console.log(infoConcurso);
                    concursos.push(infoConcurso);
                }
            } else {
                error = true;
                errores.push({ metodo: 'procesarConcursos', mensaje: pgGuatecompras.err });
                return;
            }
            item.concursos = concursos;
        }
        //console.log(item);
    }

}

/* -----------------------------Obtener el html para trabajarlo con cheerio------------------------------------ */
async function obtenerHTML(url) {
    console.log('Llamar a url', url);
    let getOperation = await new Promise((resolve, reject) => {
        request(url, (err, res, body) => {
            return resolve({ err, res, body });
        })
    });
    return getOperation;
}

/* -----------------------------Obtener la información de la entidad------------------------------------ */
function getInfoEntidad($) {

    fecha = new Date();
    fechaOnly = ("0" + fecha.getDate()).slice(-2) + "-" + ("0" + (fecha.getMonth() + 1)).slice(-2) + "-" + fecha.getFullYear();
    return ({
        entidad: $('#MasterGC_ContentBlockHolder_lblEntidad').text(),
        nit: $('#MasterGC_ContentBlockHolder_Lbl_Nit').text(),
        direccion: $('#MasterGC_ContentBlockHolder_lblDireccion').text() + ', ' +
            $('#MasterGC_ContentBlockHolder_lblMunicipio').text() + ', ' +
            $('#MasterGC_ContentBlockHolder_lblDepartamento').text(),
        telefono: $('#MasterGC_ContentBlockHolder_lblTel').text(),
        fechaActualizacion: fechaOnly
    });
}



async function procesoProductos() {

    const data = await fs.readFile('productosProcesar.json', 'utf8');
    let p = JSON.parse(data);

    //console.log(p);
    for (i in p) {
        console.log(p[i]);
        await getTipoProductos(p[i]);
    }
    console.log('Procesar productos terminado');
}



async function procesoAdjudicaciones() {

    const data = await fs.readFile('adjudicacionesProcesar.json', 'utf8');
    let p = JSON.parse(data);

    //console.log(p);
    for (i in p) {
        console.log(p[i]);
        await getAdjudicaciones(p[i]);
    }
    console.log('Procesar adjudicaiciones terminado');
}



/* ---------------------------------------esta es toda la parte de phantoms----------------------------------------- */
/* -----------------------------obtención de los concursos que están en el pagineos------------------------------------ */

async function getConcursosPagineo(url, post) {

    const instance = await phantom.create();
    const page = await instance.createPage();
    const status = await page.open(url);

    if (status.toString() != 'success') {
        error = true;
        errores.push({ metodo: 'getConcursosPagineo', mensaje: status });
        return;
    }
    var html = await page.evaluate(function (s) {

        return __doPostBack(s, '');
    }, post);

    await sleep(60000)
    const content = await page.property('content');

    let $ = cheerio.load(content);
    let tablaCategoria = $('#MasterGC_ContentBlockHolder_dgResultado');
    let filas = tablaCategoria.find('tr');

    let linksConcursos = [];
    //obtener los links de la primera pagina
    for (var i = 1; i < filas.length - 1; i++) {
        let columnas = filas.eq(i).find('td');
        linksConcursos.push(columnas.eq(1).find('a').attr('href'));
    }
    console.log(linksConcursos);
    page.close();
    await instance.exit();

    return linksConcursos;
}

/* -------------------obtención de los productos que no están guardados de cada concursos nuevo--------------------- */

async function getTipoProductos(item) {

    const instance = await phantom.create();
    const page = await instance.createPage();

    page.setting.loadImages = false;
    const status = await page.open(item.link);

    var html = await page.evaluate(function () {

        var divOpciones = document.getElementById("MasterGC_ContentBlockHolder_RadTabStrip1");
        var hrefs = divOpciones.getElementsByClassName('rtsLink');
        var hrefProducto = hrefs[2];
        hrefProducto.click();

        return document.getElementById("MasterGC_ContentBlockHolder_RadTabStrip1");

    });

    console.log(html);
    await sleep(60000)
    const content = await page.property('content');

    let $ = cheerio.load(content);
    let tablaProducto = $('#MasterGC_ContentBlockHolder_wcuConsultaConcursoProductosPub_gvTipoProducto');
    let filasP = tablaProducto.find('tr');
    var flag = false;

    for (var k = 1; k < filasP.length; k++) {
        let columnasP = filasP.eq(k).find('td');

        let producto = {
            nog: item.nog,
            nombre: columnasP.eq(0).text().trim(),
            cantidad: columnasP.eq(1).text().trim(),
            precioReferencia: columnasP.eq(2).text().trim(),
            unidadDeMedida: columnasP.eq(3).text().trim()
        };
        addProducto(producto);
        flag = true;
    }

    if (!flag) {
        nogProductosFaltantes.push({ nog: item.nog });
    }

    await page.close();
    await instance.exit();
}



/* -------------------obtención de las adjudicaciones que no están guardadas de cada concursos nuevo--------------------- */
async function getAdjudicaciones(item) {

    const instance = await phantom.create();
    const page = await instance.createPage();

    page.setting.loadImages = false;
    const status = await page.open(item.link);

    var html = await page.evaluate(function () {

        var divOpciones = document.getElementById("MasterGC_ContentBlockHolder_RadTabStrip1");
        var hrefs = divOpciones.getElementsByClassName('rtsLink');
        var hrefAdjudicaciones = hrefs[3];
        hrefAdjudicaciones.click();

        return document.getElementById("MasterGC_ContentBlockHolder_RadTabStrip1");

    });

    console.log(html);
    await sleep(60000)
    const content = await page.property('content');

    let $ = cheerio.load(content);
    let tablaAdjudicaciones = $('#MasterGC_ContentBlockHolder_wcuConsultaConcursoAdjudicaciones_acDocumentos');
    let filasA = tablaAdjudicaciones.find('tr');

    var flag = false;
    for (var k = 0; k < filasA.length; k++) {
        let columnasA = filasA.eq(k).find('td');

        let adjudicacion = {
            nog: item.nog,
            nit: columnasA.eq(1).text().trim(),
            nombre: columnasA.eq(2).text().trim(),
            contrato: columnasA.eq(3).text().trim(),
            monto: columnasA.eq(4).text().trim()
        };
        console.log(adjudicacion);
        addAdjudicaciones(adjudicacion);
        flag = true;
    }

    if (!flag) {
        nogAdjudicacionesFaltantes.push({ nog: item.nog });
    }
    await page.close();
    await instance.exit();
}

/* -------------------Agregar producto a firebase--------------------- */
function addProducto(producto) {
    var ref = db.ref("Productos");
    ref.push(producto);
}

/* -------------------Agregar adjudicación a firebase--------------------- */
function addAdjudicaciones(adjudicacion) {
    var ref = db.ref("Adjudicaciones");
    ref.push(adjudicacion);
}

/* ------------------Obtener productos de firebase--------------------- */
async function getProductosFirebase() {

    var ref = db.ref("Productos");
    prodts = await ref.once("value");
    prodtsJSON = prodts.val();

    var i = 0;
    for (p in prodtsJSON) {
        if (!productosFirebase.includes(prodtsJSON[p].nog)) {
            productosFirebase.push(prodtsJSON[p].nog);
        }
        i++;
    }
    console.log("Productos retornados por firebase ", i);
    console.log("Productos retornados por sin repetir ", productosFirebase.length);

    /*fs.writeFile('productosFirebase.json', JSON.stringify(productosFirebase), function (err) {
        if (err) return console.log(err);
        console.log('productosFirebase > productosFirebase.json');
    });*/
    //    console.log(productosFirebase.val());
}

/* ------------------Obtener adjudicaciones de firebase--------------------- */
async function getAdjudicacionesFirebase() {

    var ref = db.ref("Adjudicaciones");
    adjus = await ref.once("value");
    adjusJSON = adjus.val();

    var i = 0;
    for (p in adjusJSON) {
        if (!adjudicacionesFirebase.includes(adjusJSON[p].nog)) {
            adjudicacionesFirebase.push(adjusJSON[p].nog);
        }
        i++;
    }
    console.log("Adjundicaciones retornados por firebase ", i);
    console.log("Adjudicaciones retornados por sin repetir ", adjudicacionesFirebase.length);

    //    console.log(productosFirebase.val());
}



//sleep para que phantomjs cargue los cambios realizados 
function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

//replacement
function replaceAt(cadena, index, replacement) {
    return cadena.substr(0, index) + replacement + cadena.substr(index + replacement.length);
}



/* ------------------Enviar email de errores--------------------- */
async function sendEmail() {

    let transporter = nodemailer.createTransport({
        host: 'smtp.googlemail.com', // Gmail Host
        port: 465, // Port
        secure: true, // this is true as port is 465
        auth: {
            user: 'ecologicgt2020@gmail.com', // generated ethereal user
            pass: '@Cris1993', // generated ethereal password
        },
    });

    // send mail with defined transport object
    let info = await transporter.sendMail({
        from: '"ECOLOGIC GT" ecologicgt2020@gmail.com', // sender address
        to: "cristiankris93@gmail.com", // list of receivers
        subject: "Error en webscraping", // Subject line
        //text: "Hello world?", // plain text body
        html: "Ocurrió un error al ejecutar el proceso de webscraping para obtener los datos del portal de guatecompras.com <br/>" + JSON.stringify(errores), // html body
    });

    console.log("Email enviado: %s", info.messageId);
}


/* ------------------Enviar email de datos daltantes--------------------- */
async function sendEmail(l1,l2) {

    let transporter = nodemailer.createTransport({
        host: 'smtp.googlemail.com', // Gmail Host
        port: 465, // Port
        secure: true, // this is true as port is 465
        auth: {
            user: 'ecologicgt2020@gmail.com', // generated ethereal user
            pass: '@Cris1993', // generated ethereal password
        },
    });

    // send mail with defined transport object
    let info = await transporter.sendMail({
        from: '"ECOLOGIC GT" ecologicgt2020@gmail.com', // sender address
        to: "cristiankris93@gmail.com", // list of receivers
        subject: "Datos no cargados", // Subject line
        //text: "Hello world?", // plain text body
        html: "Faltan datos a cargar <br/> Producos " + l1+ " <br/> Adjudicaciones "+l2, // html body
    });

    console.log("Email enviado: %s", info.messageId);
}
