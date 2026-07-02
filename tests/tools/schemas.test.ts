/**
 * @fileoverview Tests for shared earthquake event schema and formatEvent helper.
 * @module tests/tools/schemas.test
 */

import { describe, expect, it } from 'vitest';
import type { EarthquakeEventOutput } from '@/mcp-server/tools/schemas.js';
import { EarthquakeEventSchema, formatEvent } from '@/mcp-server/tools/schemas.js';

const fullEvent: EarthquakeEventOutput = {
  id: 'us6000sznj',
  title: 'M 7.1 - 15 km ESE of Ridgecrest, CA',
  magnitude: 7.1,
  magnitude_type: 'mw',
  time: '2019-07-06T03:19:53.040Z',
  updated: '2019-07-08T18:00:00.000Z',
  place: '15 km ESE of Ridgecrest, CA',
  latitude: 35.7695,
  longitude: -117.5993,
  depth_km: 8,
  felt: 18000,
  cdi: 7.1,
  mmi: 8.3,
  alert: 'orange',
  tsunami: 0,
  significance: 1539,
  status: 'reviewed',
  event_url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us6000sznj',
  detail_url: 'https://earthquake.usgs.gov/fdsnws/event/1/query?eventid=us6000sznj&format=geojson',
};

const sparseEvent: EarthquakeEventOutput = {
  id: 'nc12345678',
  title: 'M 1.2 - Northern California',
  magnitude: 1.2,
  magnitude_type: 'ml',
  time: '2026-01-01T00:00:00.000Z',
  updated: '2026-01-01T00:05:00.000Z',
  place: 'Northern California',
  latitude: 38.8,
  longitude: -122.8,
  depth_km: null,
  felt: null,
  cdi: null,
  mmi: null,
  alert: null,
  tsunami: 0,
  significance: null,
  status: 'automatic',
};

describe('EarthquakeEventSchema', () => {
  it('parses a complete event with all optional fields', () => {
    const result = EarthquakeEventSchema.safeParse(fullEvent);
    expect(result.success).toBe(true);
  });

  it('parses a sparse event with null optional fields', () => {
    const result = EarthquakeEventSchema.safeParse(sparseEvent);
    expect(result.success).toBe(true);
  });

  it('rejects an event with an invalid alert value', () => {
    const result = EarthquakeEventSchema.safeParse({ ...fullEvent, alert: 'purple' });
    expect(result.success).toBe(false);
  });

  it('rejects an event with an invalid status value', () => {
    const result = EarthquakeEventSchema.safeParse({ ...fullEvent, status: 'pending' });
    expect(result.success).toBe(false);
  });

  it('accepts all valid alert levels', () => {
    for (const alert of ['green', 'yellow', 'orange', 'red'] as const) {
      const result = EarthquakeEventSchema.safeParse({ ...fullEvent, alert });
      expect(result.success).toBe(true);
    }
  });

  it('accepts null alert (no PAGER data)', () => {
    const result = EarthquakeEventSchema.safeParse({ ...fullEvent, alert: null });
    expect(result.success).toBe(true);
  });

  it('accepts all valid status values', () => {
    for (const status of ['automatic', 'reviewed', 'deleted'] as const) {
      const result = EarthquakeEventSchema.safeParse({ ...fullEvent, status });
      expect(result.success).toBe(true);
    }
  });

  it('accepts null depth_km for historical events', () => {
    const result = EarthquakeEventSchema.safeParse({ ...fullEvent, depth_km: null });
    expect(result.success).toBe(true);
  });

  it('rejects event missing required id field', () => {
    const { id: _id, ...withoutId } = fullEvent;
    const result = EarthquakeEventSchema.safeParse(withoutId);
    expect(result.success).toBe(false);
  });

  it('rejects event missing required magnitude field', () => {
    const { magnitude: _mag, ...withoutMag } = fullEvent;
    const result = EarthquakeEventSchema.safeParse(withoutMag);
    expect(result.success).toBe(false);
  });

  it('accepts event_url and detail_url as optional — omitting both is valid', () => {
    const { event_url: _eu, detail_url: _du, ...withoutUrls } = fullEvent;
    const result = EarthquakeEventSchema.safeParse(withoutUrls);
    expect(result.success).toBe(true);
  });
});

describe('formatEvent', () => {
  it('includes all key fields for a full event', () => {
    const lines = formatEvent(fullEvent);
    const text = lines.join('\n');
    expect(text).toContain(fullEvent.id);
    expect(text).toContain(String(fullEvent.magnitude));
    expect(text).toContain(fullEvent.magnitude_type);
    expect(text).toContain(fullEvent.place);
    expect(text).toContain(fullEvent.time);
    expect(text).toContain(fullEvent.updated);
    expect(text).toContain(fullEvent.status);
  });

  it('renders depth when present', () => {
    const lines = formatEvent(fullEvent);
    const text = lines.join('\n');
    expect(text).toContain('8 km');
  });

  it('renders "unknown" depth when depth_km is null', () => {
    const lines = formatEvent(sparseEvent);
    const text = lines.join('\n');
    expect(text).toContain('unknown');
  });

  it('renders PAGER alert level in uppercase for a real alert', () => {
    const lines = formatEvent(fullEvent);
    const text = lines.join('\n');
    expect(text).toContain('ORANGE');
  });

  it('renders "Not computed" when alert is null', () => {
    const lines = formatEvent(sparseEvent);
    const text = lines.join('\n');
    expect(text).toContain('Not computed');
  });

  it('renders all four alert levels correctly', () => {
    for (const alert of ['green', 'yellow', 'orange', 'red'] as const) {
      const event = { ...fullEvent, alert };
      const text = formatEvent(event).join('\n');
      expect(text).toContain(alert.toUpperCase());
    }
  });

  it('renders tsunami flag as 0 when no warning', () => {
    const lines = formatEvent(fullEvent);
    const text = lines.join('\n');
    // tsunami value 0 must appear in output
    expect(text).toMatch(/Tsunami.*0/);
  });

  it('renders tsunami warning indicator when tsunami flag is 1', () => {
    const event = { ...fullEvent, tsunami: 1 };
    const text = formatEvent(event).join('\n');
    expect(text).toContain('Warning issued');
  });

  it('renders felt count in Impact section when present', () => {
    const lines = formatEvent(fullEvent);
    const text = lines.join('\n');
    expect(text).toContain('18000');
    expect(text).toContain('DYFI');
  });

  it('renders MMI in Impact section when present', () => {
    const lines = formatEvent(fullEvent);
    const text = lines.join('\n');
    expect(text).toContain('ShakeMap MMI');
    expect(text).toContain('8.3');
  });

  it('renders CDI in Impact section when present', () => {
    const lines = formatEvent(fullEvent);
    const text = lines.join('\n');
    expect(text).toContain('CDI');
    expect(text).toContain('7.1');
  });

  it('renders significance in Impact section when present', () => {
    const lines = formatEvent(fullEvent);
    const text = lines.join('\n');
    expect(text).toContain('Significance');
    expect(text).toContain('1539');
  });

  it('omits Impact section entirely when all impact fields are null', () => {
    const lines = formatEvent(sparseEvent);
    const text = lines.join('\n');
    expect(text).not.toContain('**Impact:**');
  });

  it('renders USGS page URL when present', () => {
    const lines = formatEvent(fullEvent);
    const text = lines.join('\n');
    expect(text).toContain('USGS page:');
    expect(text).toContain(fullEvent.event_url!);
  });

  it('omits USGS page line when event_url is absent', () => {
    const lines = formatEvent(sparseEvent);
    const text = lines.join('\n');
    expect(text).not.toContain('USGS page:');
  });

  it('renders detail URL when present', () => {
    const lines = formatEvent(fullEvent);
    const text = lines.join('\n');
    expect(text).toContain('Detail URL:');
    expect(text).toContain(fullEvent.detail_url!);
  });

  it('omits detail URL line when detail_url is absent', () => {
    const lines = formatEvent(sparseEvent);
    const text = lines.join('\n');
    expect(text).not.toContain('Detail URL:');
  });

  it('renders location coordinates with 4 decimal places', () => {
    const lines = formatEvent(fullEvent);
    const text = lines.join('\n');
    // 35.7695 → 35.7695 (4 decimal places)
    expect(text).toContain('35.7695');
    // -117.5993 → -117.5993
    expect(text).toContain('-117.5993');
  });

  it('returns an array of strings (not a single string)', () => {
    const lines = formatEvent(fullEvent);
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(typeof line).toBe('string');
    }
  });

  it('does not fabricate impact data for an EMSC-style event with all nulls', () => {
    const emscStyleEvent: EarthquakeEventOutput = {
      ...sparseEvent,
      felt: null,
      cdi: null,
      mmi: null,
      significance: null,
      alert: null,
      tsunami: 0,
    };
    const text = formatEvent(emscStyleEvent).join('\n');
    // Should not contain numbers that would suggest fabricated impact data
    expect(text).not.toContain('DYFI');
    expect(text).not.toContain('ShakeMap MMI');
    expect(text).not.toContain('CDI:');
    expect(text).not.toContain('Significance:');
  });
});

describe('EarthquakeEventSchema — null magnitude (issue #13)', () => {
  it('accepts magnitude: null for events where no magnitude was computed', () => {
    const parsed = EarthquakeEventSchema.parse({
      ...sparseEvent,
      title: 'M ? - 234 km SE of Attu Station, Alaska',
      magnitude: null,
      magnitude_type: 'unknown',
    });
    expect(parsed.magnitude).toBeNull();
  });

  it('still accepts a real magnitude 0 (M0 microquakes exist)', () => {
    const parsed = EarthquakeEventSchema.parse({ ...sparseEvent, magnitude: 0 });
    expect(parsed.magnitude).toBe(0);
  });

  it('formatEvent renders null magnitude as "unknown", not 0', () => {
    const lines = formatEvent({
      ...sparseEvent,
      title: 'M ? - 234 km SE of Attu Station, Alaska',
      magnitude: null,
      magnitude_type: 'unknown',
    });
    const text = lines.join('\n');
    expect(text).toContain('**Magnitude:** unknown (unknown)');
    expect(text).not.toContain('**Magnitude:** 0');
  });

  it('formatEvent renders magnitude 0 as the number 0', () => {
    const lines = formatEvent({ ...sparseEvent, magnitude: 0 });
    expect(lines.join('\n')).toContain('**Magnitude:** 0 (ml)');
  });
});
