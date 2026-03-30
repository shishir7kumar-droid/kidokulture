require('dotenv').config();
const express = require('express');
const path = require('path');
const mongoose = require('mongoose');
const session = require('express-session');
const axios = require('axios');
const cheerio = require('cheerio');
const bcrypt = require('bcryptjs');
const cloudinary = require('cloudinary').v2;
const app = express();

// Cloudinary Configuration
if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    console.error('❌ CRITICAL: Cloudinary environment variables are missing! Check your .env file.');
}

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// 1. Setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json()); // Allow reading JSON for metadata fetch
app.use(session({
    secret: 'secret-key-kk',
    resave: false,
    saveUninitialized: true
}));

// 3. Models
const Product = mongoose.model('Product', new mongoose.Schema({
    name: String,
    price: Number,
    category: String,
    imageUrl: String,
    affiliateUrl: String
}));

const CuratedProduct = mongoose.model('CuratedProduct', new mongoose.Schema({
    name: String,
    price: Number,
    category: String,
    imageUrl: String,
    cloudinary_id: { type: String, required: false }, // Renamed for clarity
    affiliateUrl: String,
    status: { type: String, enum: ['pending', 'approved', 'rejected', 'completed'], default: 'pending' },
    isApproved: { type: Boolean, default: false }, // Added for admin filtering
    materialHighlight: String,
    ageGroup: [String],
    createdAt: { type: Date, default: Date.now }
}));

const Admin = mongoose.model('Admin', new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true }
}));

// 2. Database Connection
if (!process.env.MONGODB_URI) {
    console.warn('⚠️ MONGODB_URI is not set. Database features will fail.');
} else {
    mongoose.connect(process.env.MONGODB_URI)
        .then(async () => {
            console.log('Connected to MongoDB');
            // Initialize default admin if not exists
            const adminCount = await Admin.countDocuments();
            if (adminCount === 0) {
                const hashedPassword = await bcrypt.hash('admin', 10);
                await Admin.create({ username: 'admin', password: hashedPassword });
                console.log('Default admin created (admin/admin)');
            }
        })
        .catch(err => console.error('MongoDB connection error:', err));
}

// --- ROUTES ---

// Scraping Metadata (Lightweight)
app.post('/admin/fetch-metadata', async (req, res) => {
    if (!req.session.isAdmin) return res.status(403).json({ error: 'Unauthorized' });
    const { url } = req.body;

    try {
        const response = await axios.get(url, {
            timeout: 5000, // Quick timeout for lightweight performance
            headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' }
        });
        const $ = cheerio.load(response.data);

        // Metadata check
        let title = $('meta[property="og:title"]').attr('content') || $('h1').first().text().trim();
        let image = $('meta[property="og:image"]').attr('content') || $('img').first().attr('src');

        // Handle relative URLs
        if (image && !image.startsWith('http')) {
            const origin = new URL(url).origin;
            image = origin + (image.startsWith('/') ? '' : '/') + image;
        }

        if (!title && !image) throw new Error('No details found');
        res.json({ title, image });
    } catch (err) {
        res.status(500).json({ error: 'Site Blocked - Please enter details manually' });
    }
});

// API for Bot Curation (Receiver)
app.post('/api/bot/curate', async (req, res) => {
    const { title, material, age_group, link, affiliate_link, imageUrl } = req.body;
    
    try {
        let finalImageUrl = imageUrl;
        let cloudinaryId = null;

        // 1. If no image provided, try to fetch it from the link
        if (!finalImageUrl && link) {
            try {
                const response = await axios.get(link, { 
                    timeout: 5000,
                    headers: { 'User-Agent': 'Mozilla/5.0' }
                });
                const $ = cheerio.load(response.data);
                finalImageUrl = $('meta[property="og:image"]').attr('content') || $('img').first().attr('src');
                
                if (finalImageUrl && !finalImageUrl.startsWith('http')) {
                    const origin = new URL(link).origin;
                    finalImageUrl = origin + (finalImageUrl.startsWith('/') ? '' : '/') + finalImageUrl;
                }
            } catch (fetchErr) {
                console.log('Metadata fetch failed for bot entry, proceeding without image');
            }
        }

        // 2. Process through Cloudinary if we have an image
        if (finalImageUrl) {
            try {
                const uploadRes = await cloudinary.uploader.upload(finalImageUrl, {
                    folder: 'kidokulture_curated'
                });
                finalImageUrl = uploadRes.secure_url;
                cloudinaryId = uploadRes.public_id;
            } catch (cloudErr) {
                console.error('Cloudinary upload failed for bot entry:', cloudErr);
            }
        }

        // 3. Save to Atlas
        const newCurated = new CuratedProduct({
            name: title,
            materialHighlight: material,
            ageGroup: Array.isArray(age_group) ? age_group : [age_group],
            affiliateUrl: affiliate_link || link,
            imageUrl: finalImageUrl,
            cloudinary_id: cloudinaryId,
            isApproved: false,
            status: 'pending'
        });

        await newCurated.save();
        res.status(201).json({ success: true, id: newCurated._id, cloudinary_id: cloudinaryId });
    } catch (err) {
        console.error('Receiver Error:', err);
        res.status(500).json({ error: 'Failed to process curated product' });
    }
});

// Admin Login
app.get('/admin', (req, res) => {
    if (req.session.isAdmin) return res.redirect('/admin/dashboard');
    res.render('login', { error: null });
});

app.post('/admin/login', async (req, res) => {
    const { username, password } = req.body;
    const admin = await Admin.findOne({ username });

    if (admin && await bcrypt.compare(password, admin.password)) {
        req.session.isAdmin = true;
        res.redirect('/admin/dashboard');
    } else {
        res.render('login', { error: 'Invalid Credentials' });
    }
});

app.get('/admin/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/admin');
});

// Change Password
app.post('/admin/change-password', async (req, res) => {
    if (!req.session.isAdmin) return res.status(403).send('Unauthorized');
    const { newPassword } = req.body;
    
    try {
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await Admin.findOneAndUpdate({ username: 'admin' }, { password: hashedPassword });
        res.redirect('/admin/dashboard?msg=Password Updated Successfully');
    } catch (err) {
        res.status(500).send('Error updating password');
    }
});

// Dashboard
app.get('/admin/dashboard', async (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/admin');
    const products = await Product.find().sort({ _id: -1 }); // Get all products, newest first
    res.render('admin', { products, msg: req.query.msg });
});

// Curator Review Station
app.get('/admin/curator', async (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/admin');
    const products = await CuratedProduct.find({ isApproved: false }).sort({ createdAt: -1 });
    const rejectedCount = await CuratedProduct.countDocuments({ 
        status: 'rejected', 
        createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } 
    });
    res.render('admin/curator', { products, rejectedCount });
});

// Reject & Cleanup Cloudinary
app.post('/admin/reject-curated/:id', async (req, res) => {
    if (!req.session.isAdmin) return res.status(403).json({ error: 'Unauthorized' });
    try {
        const product = await CuratedProduct.findById(req.params.id);
        if (product) {
            if (product.cloudinary_id) {
                try {
                    // Await the destruction
                    const result = await cloudinary.uploader.destroy(product.cloudinary_id);
                    console.log(`✅ Cloudinary Delete Success for ${product.cloudinary_id}:`, result);
                } catch (cloudErr) {
                    console.error(`❌ Cloudinary Delete FAILED for ${product.cloudinary_id}. Full Error:`, JSON.stringify(cloudErr, null, 2));
                    // Continue to delete from DB even if Cloudinary fails
                }
            } else {
                console.warn(`⚠️ Skipping Cloudinary: No cloudinary_id for product ${req.params.id}`);
            }
            await CuratedProduct.findByIdAndDelete(req.params.id);
        }
        res.redirect('/admin/curator?msg=Product Rejected and Asset Cleaned');
    } catch (err) {
        console.error('🔥 System Error during reject cleanup:', err);
        res.status(500).send('Error during cleanup - check PM2 logs');
    }
});

// Mark as Completed (Sold) & Cleanup
app.post('/admin/complete-curated/:id', async (req, res) => {
    if (!req.session.isAdmin) return res.status(403).json({ error: 'Unauthorized' });
    try {
        const product = await CuratedProduct.findById(req.params.id);
        if (product) {
            if (product.cloudinary_id) {
                try {
                    const result = await cloudinary.uploader.destroy(product.cloudinary_id);
                    console.log(`✅ Cloudinary Sale Cleanup Success for ${product.cloudinary_id}:`, result);
                } catch (cloudErr) {
                    console.error(`❌ Cloudinary Sale Cleanup FAILED for ${product.cloudinary_id}. Full Error:`, JSON.stringify(cloudErr, null, 2));
                }
            }
            await CuratedProduct.findByIdAndDelete(req.params.id);
        }
        res.redirect('/admin/curator?msg=Sale Completed and Assets Purged');
    } catch (err) {
        console.error('🔥 System Error during complete cleanup:', err);
        res.status(500).send('Error during completion cleanup');
    }
});

// Bulk Cleanup Rejected (Last 24h)
app.post('/admin/bulk-cleanup-rejected', async (req, res) => {
    if (!req.session.isAdmin) return res.status(403).json({ error: 'Unauthorized' });
    try {
        const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const rejectedItems = await CuratedProduct.find({ 
            status: 'rejected', 
            createdAt: { $gte: cutoff } 
        });

        for (const item of rejectedItems) {
            if (item.cloudinary_id) {
                try {
                    const result = await cloudinary.uploader.destroy(item.cloudinary_id);
                    console.log(`✅ Bulk Cleanup Success for ${item.cloudinary_id}:`, result);
                } catch (cloudErr) {
                    console.error(`❌ Bulk Cleanup Cloudinary FAILED for ${item.cloudinary_id}. Full Error:`, JSON.stringify(cloudErr, null, 2));
                }
            }
            await CuratedProduct.findByIdAndDelete(item._id);
        }

        res.redirect('/admin/curator?msg=Bulk Cleanup Successful');
    } catch (err) {
        console.error('🔥 System Error during bulk cleanup:', err);
        res.status(500).send('Bulk cleanup failed');
    }
});

// Delete Product
app.post('/admin/delete-product/:id', async (req, res) => {
    if (!req.session.isAdmin) return res.status(403).send('Unauthorized');
    await Product.findByIdAndDelete(req.params.id);
    res.redirect('/admin/dashboard');
});

// Add Product
app.post('/admin/add-product', async (req, res) => {
    if (!req.session.isAdmin) return res.redirect('/admin');
    const { name, price, imageUrl, affiliateUrl, category } = req.body;
    await Product.create({ name, price, imageUrl, affiliateUrl, category });
    res.redirect('/admin/dashboard');
});

// Temporary Test Route for UI Verification
app.post('/admin/test-dummy-curated', async (req, res) => {
    if (!req.session.isAdmin) return res.status(403).send('Unauthorized');
    try {
        await CuratedProduct.create({
            name: "Test Wooden Blocks",
            price: 999,
            imageUrl: "https://images.unsplash.com/photo-1515488764276-beab7607c1e6?auto=format&fit=crop&q=80&w=400",
            affiliateUrl: "https://example.com",
            status: "pending",
            materialHighlight: "Real Wood",
            ageGroup: ["1-3", "3-5"]
        });
        res.redirect('/admin/curator?msg=Dummy Product Added Successfully');
    } catch (err) {
        res.status(500).send('Error adding dummy product');
    }
});

// Category Pages
app.get('/about', (req, res) => res.render('about'));

app.get('/:category', async (req, res) => {
    const category = req.params.category;
    const validCategories = ['toys', 'clothes', 'essentials'];
    
    if (!validCategories.includes(category)) {
        return res.redirect('/toys'); // Send them back to toys if the category is wrong
    }

    const products = await Product.find({ category: category });
    res.render('category', { products, category: category });
});

app.get('/', (req, res) => res.redirect('/toys'));

if (process.env.NODE_ENV !== 'production') {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`Running on http://localhost:${PORT}`));
}

module.exports = app;
