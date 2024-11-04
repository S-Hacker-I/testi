require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const admin = require('firebase-admin');

const app = express();

// Basic middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Initialize Firebase Admin
try {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
        })
    });
} catch (error) {
    console.error('Firebase initialization error:', error);
}

// Debug endpoint to check environment variables
app.get('/api/debug', (req, res) => {
    res.json({
        hasStripeKey: !!process.env.STRIPE_PUBLISHABLE_KEY,
        hasSecretKey: !!process.env.STRIPE_SECRET_KEY,
        hasFirebaseProjectId: !!process.env.FIREBASE_PROJECT_ID,
        environment: process.env.NODE_ENV
    });
});

// Config endpoint with better error handling
app.get('/api/config', (req, res) => {
    console.log('Config endpoint called');
    try {
        if (!process.env.STRIPE_PUBLISHABLE_KEY) {
            console.error('Stripe publishable key missing');
            return res.status(500).json({
                error: 'Stripe configuration missing'
            });
        }

        res.json({
            stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY
        });
    } catch (error) {
        console.error('Config endpoint error:', error);
        res.status(500).json({
            error: 'Internal server error',
            message: error.message
        });
    }
});

// Serve static files
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/auth', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'auth.html'));
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({
        error: 'Internal server error',
        message: err.message
    });
});

// Export for Vercel
module.exports = app;
