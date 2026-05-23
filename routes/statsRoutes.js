const express = require('express');
const statsController = require('../controllers/statsController');
const { requireAuth } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(requireAuth);

router.get('/calendar', statsController.getCalendar);
router.get('/summary', statsController.getSummary);

module.exports = router;
