require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Credits file path - Update for Vercel
const DATA_DIR = process.env.VERCEL ? '/tmp' : path.join(__dirname, 'data');
const CREDITS_FILE = path.join(DATA_DIR, 'credits.json');

// Helper functions for credits
async function readCredits() {
    try {
        // Ensure directory exists
        try {
            await fs.access(DATA_DIR);
        } catch {
            await fs.mkdir(DATA_DIR, { recursive: true });
        }

        // Try to read the credits file
        try {
            const data = await fs.readFile(CREDITS_FILE, 'utf8');
            return JSON.parse(data);
        } catch {
            // If file doesn't exist, create it with empty object
            const initialData = {};
            await fs.writeFile(CREDITS_FILE, JSON.stringify(initialData), 'utf8');
            return initialData;
        }
    } catch (error) {
        console.error('Error reading credits:', error);
        return {};
    }
}

async function writeCredits(credits) {
    try {
        // Ensure directory exists
        await fs.mkdir(DATA_DIR, { recursive: true });
        
        // Write the credits file
        await fs.writeFile(CREDITS_FILE, JSON.stringify(credits), 'utf8');
        console.log('Credits written successfully');
        return true;
    } catch (error) {
        console.error('Error writing credits:', error);
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

        const credits = await readCredits();
        const userCredits = credits[userId] || 5; // Default 5 credits
        res.json({ credits: userCredits });
    } catch (error) {
        console.error('Error checking credits:', error);
        res.status(500).json({ error: 'Internal server error' });
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
            success_url: `${req.protocol}://${req.get('host')}/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${req.protocol}://${req.get('host')}`,
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
            
            const credits = await readCredits();
            const currentCredits = credits[userId] || 0;
            credits[userId] = currentCredits + purchasedCredits;
            
            const writeSuccess = await writeCredits(credits);
            if (!writeSuccess) {
                throw new Error('Failed to write credits');
            }
            
            console.log(`Updated credits for user ${userId}: ${currentCredits} + ${purchasedCredits} = ${credits[userId]}`);
            
            res.json({ 
                success: true, 
                credits: credits[userId],
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

// Start server
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});