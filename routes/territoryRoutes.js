const express = require('express');
const territoryController = require('../controllers/territoryController');
const { requireAuth, optionalAuth } = require('../middleware/authMiddleware');

const router = express.Router();

// optionalAuth, not requireAuth: the map is viewable while signed out, but
// when a token IS present these endpoints use it to decide which polygons
// belong to the viewer — only those carry a username.
router.get('/all', optionalAuth, territoryController.getAllTerritories);
router.get('/bounds', optionalAuth, territoryController.getTerritoriesInBounds);

router.get('/user/territories', requireAuth, territoryController.getUserTerritories);

// Last, so it cannot shadow /all, /bounds or /user/territories.
router.get('/:territoryId', optionalAuth, territoryController.getTerritoryDetails);

module.exports = router;
