const UserStatistics = require('../models/UserStatistics');

/**
 * `metric` is mapped to a whitelisted column inside the model, never
 * interpolated from the request. Both columns carry a dedicated DESC index.
 */

exports.getLeaderboard = async (req, res, next) => {
  try {
    const metric = req.params.metric === 'distance' ? 'distance' : 'area';
    const limit = Math.min(Number(req.query.limit) || 10, 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const leaderboard = await UserStatistics.leaderboard(metric, limit, offset);
    res.json({ metric, leaderboard });
  } catch (err) {
    next(err);
  }
};

/**
 * A user's rank, as a single window-function query returning the field size
 * too, so the UI can say "7th of 42". The old implementation issued a findOne
 * followed by a separate count.
 */
exports.getUserRank = async (req, res, next) => {
  try {
    const metric = req.params.metric === 'distance' ? 'distance' : 'area';
    const result = await UserStatistics.rankFor(req.user.id, metric);

    if (!result) {
      return res.status(404).json({ message: 'No statistics recorded yet.' });
    }

    res.json({ metric, ...result });
  } catch (err) {
    next(err);
  }
};
