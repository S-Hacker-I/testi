require('dotenv').config();
const express = require('express');
const path = require('path');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const axios = require('axios');
const admin = require('firebase-admin');
const fs = require('fs').promises;

// Initialize Firebase Admin with proper error handling
try {
    if (!admin.apps.length) {
        // Parse the private key properly for production environment
        const privateKey = process.env.FIREBASE_PRIVATE_KEY 
            ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
            : undefined;

        admin.initializeApp({
            credential: admin.credential.cert({
                type: "service_account",
                project_id: process.env.FIREBASE_PROJECT_ID,
                private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
                private_key: privateKey,
                client_email: process.env.FIREBASE_CLIENT_EMAIL,
                client_id: process.env.FIREBASE_CLIENT_ID,
                auth_uri: "https://accounts.google.com/o/oauth2/auth",
                token_uri: "https://oauth2.googleapis.com/token",
                auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
                client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL
            })
        });
        console.log('Firebase initialized successfully');
    }
} catch (error) {
    console.error('Firebase initialization error:', error);
    throw error; // Throw the error to be caught by error handling middleware
}

const db = admin.firestore();
const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Add error handling middleware
app.use((err, req, res, next) => {
    console.error('Error:', err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
});

// Credit packages
const CREDIT_PACKAGES = [
    { id: 'credits_10', credits: 10, price: 5, name: 'Basic Pack' },
    { id: 'credits_25', credits: 25, price: 10, name: 'Popular Pack' },
    { id: 'credits_50', credits: 50, price: 18, name: 'Pro Pack' }
];

// Helper functions for credits using Firestore
async function getUserCredits(userId) {
    try {
        const doc = await db.collection('credits').doc(userId).get();
        return doc.exists ? doc.data().credits : 5; // Default 5 credits
    } catch (error) {
        console.error('Error getting credits:', error);
        throw error;
    }
}

async function updateUserCredits(userId, credits) {
    try {
        await db.collection('credits').doc(userId).set({ credits });
        return true;
    } catch (error) {
        console.error('Error updating credits:', error);
        throw error;
    }
}

// API Routes
app.post('/api/check-credits', async (req, res) => {
    try {
        const { userId } = req.body;
        
        if (!userId) {
            return res.status(400).json({ error: 'Missing userId' });
        }

        const doc = await db.collection('credits').doc(userId).get();
        const credits = doc.exists ? doc.data().credits : 5; // Default 5 credits

        console.log(`Credits for user ${userId}:`, credits);
        res.json({ credits });
    } catch (error) {
        console.error('Error checking credits:', error);
        res.status(500).json({ 
            error: 'Failed to check credits',
            details: error.message 
        });
    }
});

app.post('/api/generate-image', async (req, res) => {
    try {
        const { prompt, userId } = req.body;

        if (!prompt || !userId) {
            return res.status(400).json({ error: 'Missing prompt or userId' });
        }

        // Check user credits
        const userCredits = await getUserCredits(userId);
        
        if (userCredits < 1) {
            return res.status(403).json({ error: 'Insufficient credits' });
        }

        // Call Hugging Face API
        const response = await axios({
            url: "https://api-inference.huggingface.co/models/stabilityai/stable-diffusion-xl-base-1.0",
            method: 'POST',
            headers: {
                Authorization: `Bearer ${process.env.HUGGINGFACE_API_KEY}`,
                'Content-Type': 'application/json',
            },
            data: JSON.stringify({
                inputs: prompt,
                options: {
                    wait_for_model: true
                }
            }),
            responseType: 'arraybuffer'
        });

        // Convert image to base64
        const base64Image = Buffer.from(response.data).toString('base64');
        const imageUrl = `data:image/jpeg;base64,${base64Image}`;

        // Deduct credit
        const newCredits = userCredits - 1;
        await updateUserCredits(userId, newCredits);

        // Return success response
        res.json({
            success: true,
            image: imageUrl,
            credits: newCredits
        });

    } catch (error) {
        console.error('Error generating image:', error);
        
        // Send proper error response
        res.status(500).json({
            error: 'Failed to generate image',
            message: error.message
        });
    }
});

app.post('/api/create-checkout-session', async (req, res) => {
    try {
        const { packageId, userId } = req.body;
        const package = CREDIT_PACKAGES.find(p => p.id === packageId);
        
        if (!package) {
            return res.status(400).json({ error: 'Invalid package' });
        }

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: `${package.credits} Credits`,
                        description: package.name
                    },
                    unit_amount: package.price * 100,
                },
                quantity: 1,
            }],
            mode: 'payment',
            success_url: `${process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : 'http://localhost:3000'}/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : 'http://localhost:3000'}`,
            metadata: {
                userId,
                credits: package.credits.toString()
            }
        });

        res.json({ url: session.url });
    } catch (error) {
        console.error('Error creating checkout session:', error);
        res.status(500).json({ error: 'Failed to create checkout session' });
    }
});

app.get('/api/payment-success', async (req, res) => {
    try {
        const { session_id } = req.query;
        if (!session_id) {
            return res.status(400).json({ error: 'Missing session_id' });
        }

        const session = await stripe.checkout.sessions.retrieve(session_id);
        
        if (session.payment_status === 'paid') {
            const userId = session.metadata.userId;
            const purchasedCredits = parseInt(session.metadata.credits);
            
            const currentCredits = await getUserCredits(userId);
            const newCredits = currentCredits + purchasedCredits;
            
            await updateUserCredits(userId, newCredits);
            
            res.json({ 
                success: true, 
                credits: newCredits,
                purchased: purchasedCredits
            });
        } else {
            res.status(400).json({ error: 'Payment not completed' });
        }
    } catch (error) {
        console.error('Error processing payment success:', error);
        res.status(500).json({ error: 'Failed to process payment' });
    }
});

// Serve static files
app.get('/', (req, res) => {
    try {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    } catch (error) {
        console.error('Error serving index.html:', error);
        res.status(500).send('Error loading page');
    }
});

app.get('/success', (req, res) => {
    try {
        res.sendFile(path.join(__dirname, 'public', 'success.html'));
    } catch (error) {
        console.error('Error serving success.html:', error);
        res.status(500).send('Error loading success page');
    }
});

// Add before the static middleware
async function ensurePublicDirectory() {
    await fs.mkdir(path.join(__dirname, 'public'), { recursive: true });
}

// Call it when starting the server
app.listen(port, async () => {
    await ensurePublicDirectory();
    console.log(`Server running on port ${port}`);
});

function logError(error, context) {
    console.error(`[${new Date().toISOString()}] ${context}:`, error);
    console.error('Stack:', error.stack);
}

// Use it in your error handlers
app.use((err, req, res, next) => {
    logError(err, 'Global error handler');
    res.status(500).json({ error: 'Internal server error' });
});