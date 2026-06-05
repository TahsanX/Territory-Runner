/**
 * Draws territories on a Leaflet map, viewport-driven.
 *
 * The old home page fetched every territory in the database on load and drew
 * them all. This loads only what is on screen, at a zoom-appropriate level of
 * detail, and reuses layers across pans instead of rebuilding them.
 */
(function (window) {
  'use strict';

  function TerritoryLayer(map, options) {
    this.map = map;
    this.opts = options || {};
    this.group = L.layerGroup().addTo(map);
    this.labels = L.layerGroup().addTo(map);
    this.known = new Map();      // id -> { layer, labelMarker, data }
    this.inflight = null;
    this.debounce = null;

    var self = this;
    // Reload on pan/zoom, debounced: a drag fires moveend once but a
    // pinch-zoom can fire several in quick succession.
    map.on('moveend zoomend', function () { self.scheduleRefresh(); });
    map.on('zoomend', function () { self.updateLabelVisibility(); });
  }

  TerritoryLayer.prototype.scheduleRefresh = function () {
    var self = this;
    clearTimeout(this.debounce);
    this.debounce = setTimeout(function () { self.refresh(); }, 220);
  };

  TerritoryLayer.prototype.refresh = async function () {
    var b = this.map.getBounds();
    if (!b) return;

    // Cancel a still-running fetch: its viewport is already stale.
    if (this.inflight) this.inflight.abort();
    var controller = new AbortController();
    this.inflight = controller;

    try {
      var pad = b.pad(0.2);   // prefetch a margin so a small pan needs no request
      var res = await window.TRApi.get('/api/territory/bounds', {
        minLat: pad.getSouth(), maxLat: pad.getNorth(),
        minLon: pad.getWest(),  maxLon: pad.getEast(),
        zoom: Math.round(this.map.getZoom()),
        limit: 400
      }, { signal: controller.signal, allowUnauthorized: true });

      this.render(res.territories || []);
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.warn('Territory load failed:', err.message);
      }
    } finally {
      if (this.inflight === controller) this.inflight = null;
    }
  };

  TerritoryLayer.prototype.render = function (territories) {
    var seen = new Set();
    var self = this;

    territories.forEach(function (t) {
      seen.add(t.id);
      if (self.known.has(t.id)) return;   // already drawn; geometry is immutable per id
      self.add(t);
    });

    // Drop anything that left the viewport, so memory doesn't grow unbounded
    // across a long session of panning.
    this.known.forEach(function (entry, id) {
      if (!seen.has(id)) {
        self.group.removeLayer(entry.layer);
        if (entry.labelMarker) self.labels.removeLayer(entry.labelMarker);
        self.known.delete(id);
      }
    });

    this.updateLabelVisibility();
    if (this.opts.onRender) this.opts.onRender(territories);
  };

  TerritoryLayer.prototype.add = function (t) {
    if (!t.geometry) return;

    var layer = L.geoJSON(t.geometry, {
      style: window.TRMap.territoryStyle(t.isOwn),
      // Rival polygons sit below own ones so your land is never obscured.
      pane: t.isOwn ? 'overlayPane' : 'overlayPane'
    });

    var fmt = window.TRUi.fmt;
    var esc = window.TRUi.escapeHtml;

    // Own territories name themselves. For a rival's, the popup reports the
    // area only — the API never sends us their username.
    var popup = t.isOwn
      ? '<strong>' + esc(t.username || 'Your territory') + '</strong><br>' +
        '<span class="text-ink-500">' + fmt.area(t.area) + '</span><br>' +
        '<span class="text-ink-400 text-xs">Captured ' + fmt.date(t.createdAt) + '</span>'
      : '<strong>Claimed territory</strong><br>' +
        '<span class="text-ink-500">' + fmt.area(t.area) + '</span><br>' +
        '<span class="text-ink-400 text-xs">Run a loop over it to take it</span>';

    layer.bindPopup(popup);
    layer.addTo(this.group);

    var entry = { layer: layer, data: t, labelMarker: null };

    // Labels exist only for your own territories, anchored at the point the
    // server computed with ST_PointOnSurface so it lands INSIDE the shape even
    // when stealing has made it concave or punched a hole in it.
    if (t.isOwn && t.username && t.labelLat !== null && t.labelLon !== null) {
      entry.labelMarker = window.TRMap.labelMarker(t.labelLat, t.labelLon, t.username);
    }

    this.known.set(t.id, entry);
  };

  TerritoryLayer.prototype.updateLabelVisibility = function () {
    var self = this;
    this.known.forEach(function (entry) {
      if (!entry.labelMarker) return;
      var show = window.TRMap.shouldShowLabel(self.map, entry.layer);
      var attached = self.labels.hasLayer(entry.labelMarker);
      if (show && !attached) self.labels.addLayer(entry.labelMarker);
      else if (!show && attached) self.labels.removeLayer(entry.labelMarker);
    });
  };

  TerritoryLayer.prototype.fitToOwn = function () {
    var bounds = null;
    this.known.forEach(function (entry) {
      if (!entry.data.isOwn) return;
      bounds = bounds ? bounds.extend(entry.layer.getBounds()) : entry.layer.getBounds();
    });
    if (bounds && bounds.isValid()) {
      this.map.fitBounds(bounds.pad(0.2), { maxZoom: 16 });
      return true;
    }
    return false;
  };

  TerritoryLayer.prototype.count = function () { return this.known.size; };

  window.TRTerritoryLayer = TerritoryLayer;
}(window));
