const http = require('node:http');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
    if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('hello\n');
        return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found\n');
});

server.listen(PORT, () => {
    console.log(`listening on ${PORT}`);
});
