const Territory = require('../models/Territory');

/**
 * Every response here returns `username` only for the requesting user's own
 * territories (see models/Territory.js). Other runners' names are not selected
 * from the database at all, so they are genuinely absent from the payload
 * rather than hidden client-side.
 */

exports.getTerritoriesInBounds = async (req, res, next) => {
  try {
    const minLat = Number(req.query.minLat);
    const maxLat = Number(req.query.maxLat);
    const minLon = Number(req.query.minLon);
    const maxLon = Number(req.query.maxLon);

    // The old handler passed raw query strings straight into the comparison and
    // relied on implicit casting, so a missing parameter produced a 500.
    if (![minLat, maxLat, minLon, maxLon].every(Number.isFinite)) {
      return res.status(400).json({
        message: 'minLat, maxLat, minLon and maxLon are required numbers.',
      });
    }
    if (minLat > maxLat || minLon > maxLon) {
      return res.status(400).json({ message: 'Inverted bounding box.' });
    }

    const territories = await Territory.findInBounds({
      minLat, maxLat, minLon, maxLon,
      zoom: Number(req.query.zoom) || 14,
      userId: req.user?.id || null,
      limit: Number(req.query.limit) || 500,
    });

    res.json({ territories, count: territories.length });
  } catch (err) {
    next(err);
  }
};

/**
 * Initial map payload, before the client knows its viewport.
 *
 * Hard-limited and simplified. The previous version returned every territory
 * in the database with full-fidelity coordinates on every single map load.
 */
exports.getAllTerritories = async (req, res, next) => {
  try {
    const territories = await Territory.findRecent({
      userId: req.user?.id || null,
      limit: Number(req.query.limit) || 200,
      zoom: Number(req.query.zoom) || 13,
    });
    res.json({ territories, count: territories.length });
  } catch (err) {
    next(err);
  }
};

exports.getUserTerritories = async (req, res, next) => {
  try {
    const territories = await Territory.findByUser(req.user.id);
    const totalArea = territories.reduce((sum, t) => sum + t.area, 0);
    res.json({ territories, count: territories.length, totalArea });
  } catch (err) {
    next(err);
  }
};

exports.getTerritoryDetails = async (req, res, next) => {
  try {
    const id = Number(req.params.territoryId);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ message: 'Invalid territory id.' });
    }

    const territory = await Territory.findById(id, req.user?.id || null);
    if (!territory) return res.status(404).json({ message: 'Territory not found.' });

    res.json({ territory });
  } catch (err) {
    next(err);
  }
};
