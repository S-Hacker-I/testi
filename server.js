require('dotenv').config();
const express = require('express');
const path = require('path');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const axios = require('axios');
const admin = require('firebase-admin');

// Initialize Firebase Admin
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            clientId: process.env.FIREBASE_CLIENT_ID,
            privateKeyId: process.env.FIREBASE_PRIVATE_KEY_ID
        })
    });
}

const db = admin.firestore();
const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static('public'));

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
        console.error('Error reading credits:', error);
        return 5; // Default credits on error
    }
}

async function updateUserCredits(userId, credits) {
    try {
        await db.collection('credits').doc(userId).set({ credits });
        return true;
    } catch (error) {
        console.error('Error updating credits:', error);
        return false;
    }
}

// API Routes
app.post('/api/check-credits', async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) {
            return res.status(400).json({ error: 'Missing userId' });
        }
        const credits = await getUserCredits(userId);
        res.json({ credits });
    } catch (error) {
        console.error('Error checking credits:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/generate-image', async (req, res) => {
    try {
        const { prompt, userId } = req.body;
        if (!prompt || !userId) {
            return res.status(400).json({ error: 'Missing prompt or userId' });
        }

        const credits = await getUserCredits(userId);
        if (credits < 1) {
            return res.status(402).json({ error: 'Insufficient credits' });
        }

        const response = await axios({
            method: 'post',
            url: 'https://api-inference.huggingface.co/models/stabilityai/stable-diffusion-xl-base-1.0',
            headers: {
                'Authorization': `Bearer ${process.env.HUGGINGFACE_API_KEY}`,
                'Content-Type': 'application/json'
            },
            data: { 
                inputs: prompt,
                options: { wait_for_model: true }
            },
            responseType: 'arraybuffer',
            timeout: 120000
        });

        // Deduct credit
        await updateUserCredits(userId, credits - 1);
        
        const base64Image = Buffer.from(response.data).toString('base64');
        res.json({ 
            image: `data:image/jpeg;base64,${base64Image}`,
            credits: credits - 1
        });
    } catch (error) {
        console.error('Error generating image:', error);
        res.status(500).json({ error: 'Failed to generate image' });
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
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/success', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'success.html'));
});

// Start server
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});