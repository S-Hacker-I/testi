const express = require('express');
const path = require('path');
const app = express();

// Serve static files from 'public' directory
app.use(express.static('public'));

// Main routes
const dashboardRoutes = [
    '/dashboard',
    '/analytics',
    '/posts',
    '/schedule',
    '/settings',
    '/profile'
];

// Dashboard routes
dashboardRoutes.forEach(route => {
    app.get(route, (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
    });
});

// Auth routes
app.get('/signup', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'signup.html'));
});

app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Home route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API routes (if needed)
app.get('/api/user', (req, res) => {
    res.json({ status: 'success' });
});

// 404 handler - Keep this as the last route
app.use((req, res) => {
    res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// For Vercel deployment
module.exports = app;

// Start server if running directly
if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`Server is running on port ${PORT}`);
    });
} 