const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const dotenv = require('dotenv');

dotenv.config();
dotenv.config({ path: '.env.local' });

const app = express();

const PORT = process.env.PORT;
const HOST = process.env.HOST;
const API_KEY = process.env.THREEWS_API_KEY; // Either add your three.ws API key here, or add it as an env var.
const API_SERVICE_URL = process.env.API_SERVICE_URL;

function authCheck() {
    // Add you custom authorization logic here.
    return true;
 }

 app.use('', (req, res, next) => {
    if (authCheck()) {
        next();
    } else {
        res.sendStatus(403);
    }
 });

app.use('', createProxyMiddleware({
    target: API_SERVICE_URL,
    changeOrigin: true,
    headers: {
        'x-api-key': API_KEY
    }
 }));

 app.listen(PORT, HOST, () => {
    console.log(`Starting Proxy at ${HOST}:${PORT}`);
 });