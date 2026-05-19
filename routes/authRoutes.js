const express = require('express');
const authController = require('../controllers/authController');
const { requireAuth } = require('../middleware/authMiddleware');

const router = express.Router();

// Registration, login and OAuth are handled by Supabase in the browser.
// These endpoints exchange the resulting session for httpOnly cookies.
router.get('/config', authController.getPublicConfig);
router.post('/session', authController.createSession);
router.post('/logout', authController.destroySession);

router.get('/profile', requireAuth, authController.getUserProfile);
router.patch('/profile', requireAuth, authController.updateProfile);

module.exports = router;
