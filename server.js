// server.js

const express = require('express');
const request = require('request');
const app = express();
const PORT = process.env.PORT || 3000;

const searchEngines = {
    brave: 'https://www.brave.com/search',
    duckduckgo: 'https://duckduckgo.com/',
    google: 'https://www.google.com/search',
    searxng: 'https://searxng.example.org/search',
    bing: 'https://www.bing.com/search'
};

app.use(express.json());

app.get('/search', (req, res) => {
    const { query, engine } = req.query;
    const url = searchEngines[engine];
    if (!url) return res.status(400).json({ error: 'Invalid search engine' });
    
    request({ url: `${url}?q=${encodeURIComponent(query)}` }, (error, response, body) => {
        if (error) return res.status(500).json({ error: 'Failed to fetch results' });
        res.send(body);
    });
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
