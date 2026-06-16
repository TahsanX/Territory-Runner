import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View, Text, Image, Pressable } from 'react-native';
import MapLibreGL, { type CameraRef } from '@maplibre/maplibre-react-native';
import * as Location from 'expo-location';

import { api, MAPTILER_KEY, type Territory } from '../lib/api';
import { colors, territoryFill } from '../lib/theme';

/**
 * Map for the run and dashboard screens.
 *
 * MapLibre with vector tiles, which is where the migration deferred in Phase 1
 * pays off: vector tiles stay sharp at every zoom, rotate with the runner's
 * heading, and cache far better on a metered mobile connection than raster
 * ones.
 *
 * MapLibre rather than Mapbox: no account, no per-MAU pricing, and the same
 * MapTiler key the web app already uses.
 */

MapLibreGL.setAccessToken(null);   // MapLibre needs no token; MapTiler keys the style URL

const STYLE_URL = MAPTILER_KEY
  ? `https://api.maptiler.com/maps/streets-v2/style.json?key=${MAPTILER_KEY}`
  // Keyless fallback so the app still renders without configuration.
  : 'https://demotiles.maplibre.org/style.json';

// Mirrors public/js/map-config.js: names appear only when the shape is big
// enough on screen to hold them.
const LABEL_MIN_ZOOM = 14;

type Props = {
  route?: Array<[number, number]>;     // [lon, lat], GeoJSON order
  showTerritories?: boolean;
  onTerritoryCount?: (own: number) => void;
};

const FOLLOW_ZOOM = 17;

export default function RunMap({
  route = [], showTerritories = true, onTerritoryCount,
}: Props) {
  const cameraRef = useRef<CameraRef>(null);
  const [territories, setTerritories] = useState<Territory[]>([]);
  const [me, setMe] = useState<[number, number] | null>(null);
  // Following keeps the camera on the runner. Dragging the map turns it off so
  // you can look around; the re-centre button turns it back on.
  const [follow, setFollow] = useState(true);
  const lastFetch = useRef(0);

  // Own position watch, independent of the recording task, so the marker and
  // camera work before a run starts too.
  useEffect(() => {
    let sub: Location.LocationSubscription | null = null;
    let cancelled = false;
    (async () => {
      const { granted } = await Location.requestForegroundPermissionsAsync();
      if (!granted || cancelled) return;
      const last = await Location.getLastKnownPositionAsync();
      if (last && !cancelled) setMe([last.coords.longitude, last.coords.latitude]);
      sub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.High, distanceInterval: 2, timeInterval: 2000 },
        (loc) => setMe([loc.coords.longitude, loc.coords.latitude]),
      );
      if (cancelled) sub.remove();
    })().catch(() => {});
    return () => { cancelled = true; sub?.remove(); };
  }, []);

  useEffect(() => {
    if (!follow || !me) return;
    cameraRef.current?.setCamera({
      centerCoordinate: me,
      animationDuration: 600,
      animationMode: 'easeTo',
    });
  }, [me, follow]);

  function recentre() {
    setFollow(true);
    if (me) {
      cameraRef.current?.setCamera({
        centerCoordinate: me, zoomLevel: FOLLOW_ZOOM,
        animationDuration: 600, animationMode: 'easeTo',
      });
    }
  }

  async function loadTerritories(bounds: {
    ne: [number, number]; sw: [number, number]; zoom: number;
  }) {
    if (!showTerritories) return;
    // Throttle: onRegionDidChange fires repeatedly during a pinch.
    if (Date.now() - lastFetch.current < 1200) return;
    lastFetch.current = Date.now();

    try {
      const res = await api.territoriesInBounds({
        minLat: bounds.sw[1], maxLat: bounds.ne[1],
        minLon: bounds.sw[0], maxLon: bounds.ne[0],
        zoom: Math.round(bounds.zoom),
      });
      setTerritories(res.territories);
      onTerritoryCount?.(res.territories.filter((t) => t.isOwn).length);
    } catch {
      // Non-fatal: the map still works, just without other people's ground.
    }
  }

  const own = territories.filter((t) => t.isOwn && t.geometry);
  const rival = territories.filter((t) => !t.isOwn && t.geometry);

  const toFeatures = (list: Territory[]): GeoJSON.FeatureCollection => ({
    type: 'FeatureCollection',
    features: list.map((t) => ({
      type: 'Feature',
      id: t.id,
      geometry: t.geometry as any,
      properties: { id: t.id, area: t.area },
    })),
  });

  // Labels only for the viewer's own territories. Other runners' usernames are
  // never sent by the API, so there is nothing to render for them even if we
  // wanted to.
  const labelFeatures: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: own
      .filter((t) => t.username && t.labelLat !== null && t.labelLon !== null)
      .map((t) => ({
        type: 'Feature',
        id: `label-${t.id}`,
        // label_lon/label_lat come from ST_PointOnSurface, so the anchor is
        // guaranteed to sit inside the shape even after a steal has made it
        // concave or punched a hole in it.
        geometry: { type: 'Point', coordinates: [t.labelLon!, t.labelLat!] },
        properties: { label: t.username! },
      })),
  };

  return (
    <View style={s.wrap}>
      <MapLibreGL.MapView
        style={s.map}
        mapStyle={STYLE_URL}
        logoEnabled={false}
        attributionEnabled
        compassEnabled
        onRegionWillChange={(feature: any) => {
          if (feature?.properties?.isUserInteraction) setFollow(false);
        }}
        onRegionDidChange={(feature: any) => {
          const props = feature?.properties;
          if (props?.visibleBounds) {
            loadTerritories({
              ne: props.visibleBounds[0],
              sw: props.visibleBounds[1],
              zoom: props.zoomLevel ?? 14,
            });
          }
        }}
      >
        <MapLibreGL.Camera
          ref={cameraRef}
          defaultSettings={{ centerCoordinate: [90.4125, 23.8103], zoomLevel: FOLLOW_ZOOM }}
        />

        {/* Rivals first, so your own ground always draws on top. */}
        {rival.length > 0 && (
          <MapLibreGL.ShapeSource id="rival-territories" shape={toFeatures(rival)}>
            <MapLibreGL.FillLayer
              id="rival-fill"
              style={{
                fillColor: territoryFill.rival.fill,
                fillOpacity: territoryFill.rival.fillOpacity,
              }}
            />
            <MapLibreGL.LineLayer
              id="rival-line"
              style={{
                lineColor: territoryFill.rival.line,
                lineWidth: territoryFill.rival.lineWidth,
                lineOpacity: 0.7,
              }}
            />
          </MapLibreGL.ShapeSource>
        )}

        {own.length > 0 && (
          <MapLibreGL.ShapeSource id="own-territories" shape={toFeatures(own)}>
            <MapLibreGL.FillLayer
              id="own-fill"
              style={{
                fillColor: territoryFill.own.fill,
                fillOpacity: territoryFill.own.fillOpacity,
              }}
            />
            <MapLibreGL.LineLayer
              id="own-line"
              style={{
                lineColor: territoryFill.own.line,
                lineWidth: territoryFill.own.lineWidth,
              }}
            />
          </MapLibreGL.ShapeSource>
        )}

        {labelFeatures.features.length > 0 && (
          <MapLibreGL.ShapeSource id="territory-labels" shape={labelFeatures}>
            <MapLibreGL.SymbolLayer
              id="territory-label-text"
              minZoomLevel={LABEL_MIN_ZOOM}
              style={{
                textField: ['get', 'label'],
                textSize: 12,
                textFont: ['Open Sans Semibold', 'Arial Unicode MS Bold'],
                textColor: colors.white,
                // The halo is what makes the name readable over both pale
                // roads and dark parkland — the equivalent of the web app's
                // white ring on .territory-label.
                textHaloColor: colors.ink[900],
                textHaloWidth: 2,
                textHaloBlur: 0.4,
                // Drop a label rather than overlapping a neighbour's.
                textAllowOverlap: false,
                textIgnorePlacement: false,
                textPadding: 4,
              }}
            />
          </MapLibreGL.ShapeSource>
        )}

        {route.length > 1 && (
          <MapLibreGL.ShapeSource
            id="route"
            shape={{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: route } }}
          >
            <MapLibreGL.LineLayer
              id="route-line"
              style={{
                lineColor: colors.accent[600],
                lineWidth: 4,
                lineCap: 'round',
                lineJoin: 'round',
              }}
            />
          </MapLibreGL.ShapeSource>
        )}

        {me && (
          <MapLibreGL.MarkerView coordinate={me} anchor={{ x: 0.5, y: 0.5 }} allowOverlap>
            <Image source={require('../assets/marker.png')} style={s.marker} />
          </MapLibreGL.MarkerView>
        )}
      </MapLibreGL.MapView>

      {!follow && (
        <Pressable style={s.recentre} onPress={recentre} accessibilityLabel="Re-centre on me">
          <Text style={s.recentreText}>Re-centre on me</Text>
        </Pressable>
      )}

      {!MAPTILER_KEY && (
        <View style={s.notice}>
          <Text style={s.noticeText}>
            EXPO_PUBLIC_MAPTILER_KEY is not set — showing the MapLibre demo basemap.
          </Text>
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1 },
  map: { flex: 1 },
  notice: {
    position: 'absolute', top: 8, left: 8, right: 8,
    backgroundColor: colors.warning,
    opacity: 0.93,
    borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6,
  },
  noticeText: { color: colors.white, fontSize: 11 },
  marker: { width: 40, height: 40 },
  recentre: {
    position: 'absolute', right: 12, bottom: 12,
    backgroundColor: colors.accent[600],
    borderRadius: 999, paddingHorizontal: 14, paddingVertical: 9,
    elevation: 4,
  },
  recentreText: { color: colors.white, fontSize: 13, fontWeight: '600' },
});
