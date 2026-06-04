/**
 * Single place where the basemap, territory styling and the runner mark are
 * defined. Changing tile provider is a one-line edit here.
 *
 * The previous build hardcoded `https://{s}.tile.openstreetmap.org/...` in two
 * separate files. That hotlinks OSM's own tile servers, which their usage
 * policy does not permit for an application, and `{s}` subdomain sharding is
 * deprecated. It also hardcoded cdnjs URLs for the default marker images,
 * twice, to work around Leaflet's broken icon path.
 */
(function (window) {
  'use strict';

  var cfg = window.TR_CONFIG || {};

  // Falls back to OSM raster when no key is configured, so the app still runs
  // out of the box — but the warning is logged, because that path should not
  // reach production.
  function tileLayer() {
    if (cfg.maptilerKey) {
      var style = cfg.maptilerStyle || 'streets-v2';
      return L.tileLayer(
        'https://api.maptiler.com/maps/' + style + '/{z}/{x}/{y}.png?key=' + cfg.maptilerKey,
        {
          attribution:
            '<a href="https://www.maptiler.com/copyright/">MapTiler</a> · ' +
            '<a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
          maxZoom: 20,
          crossOrigin: true,
          // Keep a ring of tiles outside the viewport so panning during a run
          // doesn't flash grey.
          keepBuffer: 3,
          updateWhenIdle: false,
        }
      );
    }

    console.warn('MAPTILER_KEY is not set — using OpenStreetMap raster tiles.');
    return L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '<a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
      keepBuffer: 2,
    });
  }

  // The old defaults disagreed: the run page opened on New York, the home page
  // on Dhaka. One shared fallback, overridden by the last known position.
  var FALLBACK_CENTRE = [23.8103, 90.4125];
  var FALLBACK_ZOOM = 13;

  function lastCentre() {
    try {
      var raw = window.localStorage.getItem('tr-last-centre');
      if (raw) {
        var p = JSON.parse(raw);
        if (isFinite(p.lat) && isFinite(p.lon)) return [p.lat, p.lon];
      }
    } catch (e) { /* private mode or blocked storage */ }
    return FALLBACK_CENTRE;
  }

  function rememberCentre(lat, lon) {
    try {
      window.localStorage.setItem('tr-last-centre', JSON.stringify({ lat: lat, lon: lon }));
    } catch (e) { /* non-essential */ }
  }

  function createMap(elementId, options) {
    options = options || {};
    var map = L.map(elementId, {
      center: options.center || lastCentre(),
      zoom: options.zoom || FALLBACK_ZOOM,
      zoomControl: options.zoomControl !== false,
      // Leaflet's default fade looks sluggish when panning a live run.
      fadeAnimation: false,
      preferCanvas: true,   // one canvas for many polygons beats one DOM node each
      attributionControl: true,
    });
    tileLayer().addTo(map);
    return map;
  }

  /**
   * Territory fill. Own vs rival, desaturated so the basemap stays legible —
   * the old #2ecc71 / #e74c3c at 0.35 opacity drowned the streets underneath,
   * which is part of why the map felt imprecise.
   */
  function territoryStyle(isOwn) {
    return isOwn
      ? { color: '#0d9488', weight: 2, opacity: 0.9, fillColor: '#5eead4', fillOpacity: 0.3 }
      : { color: '#b45309', weight: 1.5, opacity: 0.7, fillColor: '#fcd34d', fillOpacity: 0.18 };
  }

  /** Runner position mark: the favicon in a ring, so it reads as "you". */
  function runnerIcon() {
    return L.divIcon({
      className: 'runner-marker',
      iconSize: [40, 40],
      iconAnchor: [20, 20],
      html: '<img src="/img/favicon.svg" width="34" height="34" alt="" ' +
            'style="border-radius:9px;box-shadow:0 0 0 3px #fff,0 2px 6px rgba(0,0,0,.35)">',
    });
  }

  /**
   * Accuracy circle instead of a hard pin.
   *
   * More honest than a precise-looking dot — it shows how much the fix should
   * actually be trusted — and visually calmer than a bouncing marker.
   */
  function accuracyCircle(latlng, radiusM) {
    return L.circle(latlng, {
      radius: Math.max(radiusM || 0, 3),
      color: '#2f7df5',
      weight: 1,
      opacity: 0.35,
      fillColor: '#2f7df5',
      fillOpacity: 0.08,
      interactive: false,
    });
  }

  function routeLine() {
    return L.polyline([], {
      color: '#1b60d6', weight: 4, opacity: 0.85,
      lineJoin: 'round', lineCap: 'round',
    });
  }

  /**
   * Name label for a territory.
   *
   * Only ever created for the viewer's own territories; other runners' names
   * are not returned by the API at all. Suppressed below a zoom threshold and
   * when the polygon is too small on screen to hold the text — a label wider
   * than the shape it names is worse than no label.
   */
  var LABEL_MIN_ZOOM = 14;
  var LABEL_MIN_PX = 44;

  function shouldShowLabel(map, layer) {
    if (map.getZoom() < LABEL_MIN_ZOOM) return false;
    try {
      var b = layer.getBounds();
      var nw = map.latLngToContainerPoint(b.getNorthWest());
      var se = map.latLngToContainerPoint(b.getSouthEast());
      return Math.abs(se.x - nw.x) >= LABEL_MIN_PX &&
             Math.abs(se.y - nw.y) >= LABEL_MIN_PX * 0.5;
    } catch (e) { return false; }
  }

  function labelMarker(lat, lon, text) {
    var safe = window.TRUi ? window.TRUi.escapeHtml(text) : String(text);
    return L.marker([lat, lon], {
      // Non-interactive so the label cannot swallow a click meant for the
      // polygon beneath it.
      interactive: false,
      keyboard: false,
      icon: L.divIcon({
        className: '',
        html: '<span class="territory-label">' + safe + '</span>',
        iconSize: null,
      }),
    });
  }

  window.TRMap = {
    createMap: createMap,
    tileLayer: tileLayer,
    territoryStyle: territoryStyle,
    runnerIcon: runnerIcon,
    accuracyCircle: accuracyCircle,
    routeLine: routeLine,
    labelMarker: labelMarker,
    shouldShowLabel: shouldShowLabel,
    rememberCentre: rememberCentre,
    lastCentre: lastCentre,
    LABEL_MIN_ZOOM: LABEL_MIN_ZOOM,
    FALLBACK_CENTRE: FALLBACK_CENTRE,
  };
}(window));
