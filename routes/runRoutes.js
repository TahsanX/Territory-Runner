const express = require('express');
const runController = require('../controllers/runController');
const { requireAuth } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(requireAuth);

router.post('/start', runController.startSession);

// Batched coordinate upload. One request carries up to 500 fixes; the old
// singular /coordinate endpoint took one per request, which is what made a
// 30-minute run cost ~1,800 round trips.
router.post('/:sessionId/coordinates', runController.addCoordinates);

router.post('/:sessionId/pause', runController.pauseSession);
router.post('/:sessionId/finish', runController.finishSession);

// Declared before /:sessionId so the literal path is matched first.
router.get('/history/all', runController.getRunHistory);
router.get('/:sessionId/state', runController.getSessionState);
router.get('/:sessionId', runController.getSession);

module.exports = router;
