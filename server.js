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

// Ensure data directory exists
const DATA_DIR = path.join(__dirname, 'data');
const CREDITS_FILE = path.join(DATA_DIR, 'credits.json');

// Initialize data directory and credits file
async function initializeDataDirectory() {
    try {
        // Check if data directory exists, if not create it
        try {
            await fs.access(DATA_DIR);
        } catch {
            await fs.mkdir(DATA_DIR, { recursive: true });
        }

        // Check if credits file exists, if not create it
        try {
            await fs.access(CREDITS_FILE);
        } catch {
            await fs.writeFile(CREDITS_FILE, '{}', 'utf8');
        }
    } catch (error) {
        console.error('Error initializing data directory:', error);
    }
}

// Credit packages
const CREDIT_PACKAGES = [
    { id: 'credits_10', credits: 10, price: 5, name: 'Basic Pack' },
    { id: 'credits_25', credits: 25, price: 10, name: 'Popular Pack' },
    { id: 'credits_50', credits: 50, price: 18, name: 'Pro Pack' }
];

// Helper functions for credits
async function readCredits() {
    try {
        // Ensure the data directory exists
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
            await fs.writeFile(CREDITS_FILE, '{}', 'utf8');
            return {};
        }
    } catch (error) {
        console.error('Error reading credits:', error);
        return {};
    }
}

async function writeCredits(credits) {
    try {
        // Ensure the data directory exists
        await fs.mkdir(DATA_DIR, { recursive: true });
        
        // Write the credits file
        await fs.writeFile(CREDITS_FILE, JSON.stringify(credits, null, 2), 'utf8');
        console.log('Credits written successfully');
    } catch (error) {
        console.error('Error writing credits:', error);
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
        if (!packageId || !userId) {
            return res.status(400).json({ error: 'Missing packageId or userId' });
        }

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

        // Retrieve the session from Stripe
        const session = await stripe.checkout.sessions.retrieve(session_id);
        
        if (session.payment_status === 'paid') {
            const userId = session.metadata.userId;
            const purchasedCredits = parseInt(session.metadata.credits);
            
            // Read current credits
            const credits = await readCredits();
            
            // Add new credits
            const currentCredits = credits[userId] || 0;
            const newCredits = currentCredits + purchasedCredits;
            
            // Update credits in file
            credits[userId] = newCredits;
            await writeCredits(credits);
            
            console.log(`Updated credits for user ${userId}: ${currentCredits} + ${purchasedCredits} = ${newCredits}`);
            
            // Return success with new credit balance
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

app.post('/api/generate-image', async (req, res) => {
    try {
        const { prompt, userId } = req.body;
        
        if (!prompt || !userId) {
            return res.status(400).json({ error: 'Missing prompt or userId' });
        }

        // Check credits
        const credits = await readCredits();
        const userCredits = credits[userId] || 0;
        console.log(`User ${userId} has ${userCredits} credits`);
        
        if (userCredits < 1) {
            return res.status(402).json({ error: 'Insufficient credits' });
        }

        // Call Hugging Face API
        const response = await axios({
            method: 'post',
            url: 'https://api-inference.huggingface.co/models/stabilityai/stable-diffusion-xl-base-1.0',
            headers: {
                'Authorization': `Bearer ${process.env.HUGGINGFACE_API_KEY}`,
                'Content-Type': 'application/json'
            },
            data: { 
                inputs: prompt,
                options: {
                    wait_for_model: true
                }
            },
            responseType: 'arraybuffer',
            timeout: 120000 // 2 minutes timeout
        });

        // Deduct credit only if image generation was successful
        credits[userId] = userCredits - 1;
        await writeCredits(credits);

        const base64Image = Buffer.from(response.data).toString('base64');
        res.json({ 
            image: `data:image/jpeg;base64,${base64Image}`,
            credits: credits[userId]
        });
    } catch (error) {
        console.error('Error generating image:', error);
        if (error.response) {
            res.status(error.response.status).json({ 
                error: 'Failed to generate image',
                details: error.response.data
            });
        } else {
            res.status(500).json({ error: 'Internal server error' });
        }
    }
});

// Serve static files
app.get('/success', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'success.html'));
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Initialize data directory and start server
initializeDataDirectory().then(() => {
    app.listen(port, () => {
        console.log(`Server running on port ${port}`);
        console.log(`Data directory: ${DATA_DIR}`);
    });
}).catch(error => {
    console.error('Failed to initialize server:', error);
    process.exit(1);
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// Handle 404
app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
});