require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const admin = require('firebase-admin');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

const app = express();

// Initialize Firebase Admin
admin.initializeApp({
    credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    })
});

// Middleware
app.use(express.static('public'));
app.use(express.json());
app.use(cors());
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: [
                "'self'",
                "'unsafe-inline'",
                "'unsafe-eval'",
                "https://js.stripe.com",
                "https://www.gstatic.com",
                "https://cdn.tailwindcss.com",
                "https://identitytoolkit.googleapis.com"
            ],
            styleSrc: [
                "'self'",
                "'unsafe-inline'",
                "https://fonts.googleapis.com",
                "https://cdn.tailwindcss.com"
            ],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            imgSrc: ["'self'", "https://img.icons8.com", "data:", "https:"],
            connectSrc: [
                "'self'",
                "https://api.stripe.com",
                "https://firestore.googleapis.com",
                "https://identitytoolkit.googleapis.com",
                "https://*.googleapis.com",
                "wss://*.firebaseio.com"
            ],
            frameSrc: ["'self'", "https://js.stripe.com"],
            scriptSrcAttr: ["'unsafe-inline'"]
        },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" }
}));

app.use((req, res, next) => {
    res.locals.nonce = crypto.randomBytes(16).toString('base64');
    next();
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

// Move rate limiter before the route definition
const checkoutLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: 'Too many checkout attempts, please try again later' }
});

// Create points checkout session
app.post('/api/create-points-checkout', checkoutLimiter, async (req, res) => {
    try {
        const { points, userId } = req.body;
        
        if (!points || !userId) {
            return res.status(400).json({ error: 'Missing required parameters' });
        }

        const amount = points * 10; // $0.10 per point

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: `${points} Points Package`,
                        description: `Purchase ${points} points for your account`
                    },
                    unit_amount: amount
                },
                quantity: 1
            }],
            mode: 'payment',
            success_url: `${process.env.BASE_URL}/dashboard?success=true&points=${points}`,
            cancel_url: `${process.env.BASE_URL}/dashboard?canceled=true`,
            metadata: {
                userId,
                points: points.toString()
            }
        });

        res.json({ url: session.url });
    } catch (error) {
        console.error('Checkout error:', error);
        res.status(500).json({ error: 'Failed to create checkout session' });
    }
});

// Move webhook endpoint BEFORE express.json() middleware
app.post('/api/webhook', 
    express.raw({type: 'application/json'}), 
    async (req, res) => {
        const sig = req.headers['stripe-signature'];
        
        try {
            const event = stripe.webhooks.constructEvent(
                req.body,
                sig,
                process.env.STRIPE_WEBHOOK_SECRET
            );

            console.log('Webhook received:', event.type);

            if (event.type === 'checkout.session.completed') {
                const session = event.data.object;
                console.log('Processing payment for session:', session.id);
                await handleSuccessfulPayment(session);
                console.log(`Payment successful for user ${session.metadata.userId}`);
            }

            res.json({ received: true });
        } catch (err) {
            console.error('Webhook error:', err);
            console.error('Request body:', req.body);
            return res.status(400).send(`Webhook Error: ${err.message}`);
        }
    }
);

// Optimize the payment handling function
async function handleSuccessfulPayment(session) {
    const { userId, points } = session.metadata;
    
    if (!userId || !points) {
        throw new Error('Missing metadata');
    }

    const userRef = admin.firestore().collection('users').doc(userId);
    
    try {
        // Use a transaction for atomic updates
        await admin.firestore().runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userRef);
            
            if (!userDoc.exists) {
                throw new Error('User not found');
            }

            const currentPoints = userDoc.data().points || 0;
            const newPoints = currentPoints + parseInt(points);

            // Update user points
            await transaction.update(userRef, { 
                points: newPoints,
                lastUpdated: admin.firestore.FieldValue.serverTimestamp()
            });

            // Create purchases collection and add document
            const purchaseRef = userRef.collection('purchases').doc();
            await transaction.set(purchaseRef, {
                points: parseInt(points),
                amount: session.amount_total,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                paymentId: session.payment_intent,
                status: 'completed',
                previousPoints: currentPoints,
                newTotal: newPoints
            });
        });

        console.log(`Successfully updated points for user ${userId}: +${points} points`);
    } catch (error) {
        console.error('Transaction failed:', error);
        throw error;
    }
}

// Add this after your other middleware
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ 
        error: 'Internal server error', 
        message: process.env.NODE_ENV === 'development' ? err.message : undefined 
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
