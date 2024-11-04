require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { HfInference } = require('@huggingface/inference');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');

const app = express();
const hf = new HfInference(process.env.HUGGINGFACE_TOKEN);

const corsOptions = {
    origin: process.env.NODE_ENV === 'production' 
        ? ['https://testi-gilt.vercel.app'] 
        : ['http://localhost:3000'],
    methods: ['GET', 'POST'],
    credentials: true,
    optionsSuccessStatus: 200
};

// Move these to the top, right after the initial requires
app.use(cors(corsOptions));
app.use(express.json({ limit: '1mb' }));
app.use(helmet({
    contentSecurityPolicy: false // Temporarily disable for development
}));
app.use(express.static('public', {
    maxAge: '1h' // Cache static files for 1 hour
}));

// Optimize rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
});

// Special handling for Stripe webhook - must be before other middleware
app.post('/webhook', express.raw({type: 'application/json'}), async (request, response) => {
    const sig = request.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(
            request.body,
            sig,
            process.env.STRIPE_WEBHOOK_SECRET
        );
    } catch (err) {
        console.error('Webhook signature verification failed:', err.message);
        return response.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
        if (event.type === 'checkout.session.completed') {
            const session = event.data.object;
            const { userId, points, type } = session.metadata;

            // Update user's points in Firestore
            const userRef = admin.firestore().collection('users').doc(userId);
            await admin.firestore().runTransaction(async (transaction) => {
                const userDoc = await transaction.get(userRef);
                if (!userDoc.exists) {
                    throw new Error('User not found');
                }

                const currentPoints = userDoc.data().points || 0;
                const newPoints = currentPoints + parseInt(points);

                transaction.update(userRef, {
                    points: newPoints,
                    lastPurchase: admin.firestore.FieldValue.serverTimestamp(),
                    lastPurchaseType: type,
                    lastPurchaseAmount: session.amount_total
                });
            });

            // Add purchase to user's history
            await userRef.collection('purchases').add({
                amount: session.amount_total,
                points: parseInt(points),
                type: type,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                paymentId: session.payment_intent
            });
        }

        response.json({received: true});
    } catch (error) {
        console.error('Webhook processing failed:', error);
        response.status(500).send(`Webhook processing failed: ${error.message}`);
    }
});

// Route handlers for clean URLs
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/index.html'));
});

app.get('/index', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/index.html'));
});

app.get('/auth', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/auth.html'));
});

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/dashboard.html'));
});

// API endpoints
app.post('/api/create-checkout-session', async (req, res) => {
    try {
        const { plan, userId } = req.body;
        
        // Validate user exists
        const userDoc = await admin.firestore().collection('users').doc(userId).get();
        if (!userDoc.exists) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Define prices for different plans
        const prices = {
            starter: {
                amount: 1500, // $15.00
                points: 25
            },
            pro: {
                amount: 2500, // $25.00
                points: 50
            },
            premium: {
                amount: 3500, // $35.00
                points: 100
            }
        };

        const planDetails = prices[plan];
        if (!planDetails) {
            return res.status(400).json({ error: 'Invalid plan selected' });
        }

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: `TikSave ${plan.charAt(0).toUpperCase() + plan.slice(1)} Plan`,
                        description: `${planDetails.points} AI Generations`
                    },
                    unit_amount: planDetails.amount,
                },
                quantity: 1,
            }],
            mode: 'payment',
            success_url: `${process.env.NODE_ENV === 'production' ? 'https://testi-gilt.vercel.app' : 'http://localhost:3000'}/dashboard?success=true`,
            cancel_url: `${process.env.NODE_ENV === 'production' ? 'https://testi-gilt.vercel.app' : 'http://localhost:3000'}/dashboard`,
            metadata: {
                userId,
                points: planDetails.points,
                plan,
                type: 'plan_purchase'
            }
        });

        res.json({ url: session.url });
    } catch (error) {
        console.error('Checkout error:', error);
        res.status(500).json({ error: 'Failed to create checkout session' });
    }
});

app.post('/api/generate-caption', async (req, res) => {
    try {
        const { description } = req.body;
        
        // Generate caption using HuggingFace
        const response = await hf.textGeneration({
            model: 'gpt2',
            inputs: `Generate a viral TikTok caption for this video: ${description}\nCaption:`,
            parameters: {
                max_length: 100,
                temperature: 0.7,
                top_p: 0.9
            }
        });

        const caption = response.generated_text.split('Caption:')[1].trim();
        res.json({ caption });
    } catch (error) {
        console.error('Caption generation error:', error);
        res.status(500).json({ error: 'Failed to generate caption' });
    }
});

app.post('/api/generate-hashtags', async (req, res) => {
    try {
        const { description } = req.body;
        
        // Generate hashtags using HuggingFace
        const response = await hf.textGeneration({
            model: 'gpt2',
            inputs: `Generate trending TikTok hashtags for this video: ${description}\nHashtags:`,
            parameters: {
                max_length: 100,
                temperature: 0.7,
                top_p: 0.9
            }
        });

        const hashtags = response.generated_text.split('Hashtags:')[1].trim();
        res.json({ hashtags });
    } catch (error) {
        console.error('Hashtags generation error:', error);
        res.status(500).json({ error: 'Failed to generate hashtags' });
    }
});

// Add this near your other endpoints
app.get('/api/firebase-config', (req, res) => {
    const firebaseConfig = {
        apiKey: process.env.FIREBASE_API_KEY,
        authDomain: process.env.FIREBASE_AUTH_DOMAIN,
        projectId: process.env.FIREBASE_PROJECT_ID,
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
        messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
        appId: process.env.FIREBASE_APP_ID,
        measurementId: process.env.FIREBASE_MEASUREMENT_ID
    };
    res.json(firebaseConfig);
});

// Add this new endpoint for points purchase
app.post('/api/create-points-checkout', async (req, res) => {
    try {
        const { points, userId } = req.body;
        
        // Validate required fields
        if (!userId || !points) {
            return res.status(400).json({ 
                error: 'Missing required fields',
                details: 'Both userId and points are required'
            });
        }
        
        // Validate user exists
        const userRef = admin.firestore().collection('users').doc(userId);
        const userDoc = await userRef.get();
        
        if (!userDoc.exists) {
            return res.status(404).json({ 
                error: 'User not found',
                details: 'The specified user does not exist'
            });
        }
        
        // Validate points amount
        const pointsNum = parseInt(points);
        if (isNaN(pointsNum) || pointsNum < 10 || pointsNum > 5000) {
            return res.status(400).json({ 
                error: 'Invalid points amount',
                details: 'Points must be between 10 and 5000'
            });
        }

        // Calculate price ($0.10 per point)
        const unitAmount = 10; // $0.10 in cents
        const amount = pointsNum * unitAmount;

        // Create Stripe session with error handling
        try {
            const session = await stripe.checkout.sessions.create({
                payment_method_types: ['card'],
                line_items: [{
                    price_data: {
                        currency: 'usd',
                        product_data: {
                            name: `${pointsNum} TikSave Points`,
                            description: 'Points for AI generations'
                        },
                        unit_amount: unitAmount,
                    },
                    quantity: pointsNum,
                }],
                mode: 'payment',
                success_url: `${process.env.NODE_ENV === 'production' ? 'https://testi-gilt.vercel.app' : 'http://localhost:3000'}/dashboard?success=true&points=${pointsNum}`,
                cancel_url: `${process.env.NODE_ENV === 'production' ? 'https://testi-gilt.vercel.app' : 'http://localhost:3000'}/dashboard`,
                metadata: {
                    userId,
                    points: pointsNum.toString(),
                    type: 'points_purchase'
                }
            });

            res.json({ url: session.url });
        } catch (stripeError) {
            console.error('Stripe session creation error:', stripeError);
            return res.status(500).json({
                error: 'Payment processing error',
                details: stripeError.message
            });
        }
    } catch (error) {
        console.error('Points checkout error:', error);
        res.status(500).json({ 
            error: 'Server error',
            details: error.message 
        });
    }
});

// Handle 404
app.use((req, res) => {
    res.status(404).sendFile(path.join(__dirname, 'public/404.html'));
});

// Initialize Firebase Admin
admin.initializeApp({
    credential: admin.credential.cert({
        type: "service_account",
        project_id: process.env.FIREBASE_PROJECT_ID,
        private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        client_email: process.env.FIREBASE_CLIENT_EMAIL,
        client_id: process.env.FIREBASE_CLIENT_ID,
        auth_uri: "https://accounts.google.com/o/oauth2/auth",
        token_uri: "https://oauth2.googleapis.com/token",
        auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
        client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL
    })
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
