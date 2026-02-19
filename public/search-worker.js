/**
 * BBC Radio Explorer
 * Copyright (c) 2026 Thomas Geppert
 * BSD 3-Clause License
 */

// Load shared constants
importScripts('shared/constants.js');

const CONCURRENT_LIMIT = 6; // Browser connection limit
const CACHE_NAME = 'bbc-radio-schedules';

// Cache: stationId:dateStr -> { data, timestamp }
const cache = new Map();

// Search index: term -> Set of {stationId, start} keys
const searchIndex = new Map();

// Track prefetch progress
let prefetchComplete = false;
let totalEndpoints = 0;
let fetchedEndpoints = 0;

// Format date for API (YYYY-MM-DD)
function getFormattedDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// Fetch a single schedule endpoint with caching
async function fetchWithCache(stationId, dateStr) {
    const cacheKey = `${stationId}:${dateStr}`;
    const url = `https://rms.api.bbc.co.uk/v2/experience/inline/schedules/${stationId}/${dateStr}`;
    const proxyUrl = PROXY_BASE_URL + encodeURIComponent(url);
    const now = Date.now();

    // Check memory cache first
    if (cache.has(cacheKey)) {
        const cached = cache.get(cacheKey);
        if (now - cached.timestamp < CACHE_DURATION) {
            return cached.data;
        }
    }

    // Try Cache API (may not be available in all worker contexts)
    try {
        if (typeof caches !== 'undefined') {
            const cachedResponse = await caches.match(proxyUrl);
            if (cachedResponse) {
                const cachedData = await cachedResponse.json();
                // Cache API stores {data, timestamp} - just return the data
                // Timestamp validation is handled by the memory cache for fresh entries
                cache.set(cacheKey, cachedData);
                return cachedData.data;
            }
        }
    } catch (e) {
        // Cache API not available, continue with memory cache or network fetch
    }

    // Fetch via proxy
    try {
        const response = await fetch(proxyUrl);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();

        // Store in both memory cache and Cache API
        const cacheEntry = { data, timestamp: now };
        cache.set(cacheKey, cacheEntry);

        // Notify main thread to persist to localStorage
        self.postMessage({
            type: 'scheduleCached',
            stationId,
            dateStr,
            data,
            timestamp: now
        });

        // Save to Cache API if available (fire and forget)
        if (typeof caches !== 'undefined') {
            try {
                const response = new Response(JSON.stringify(cacheEntry), {
                    headers: { 'Content-Type': 'application/json' }
                });
                caches.open(CACHE_NAME).then(c => c.put(proxyUrl, response)).catch(() => {});
            } catch (e) {
                // Ignore cache write errors
            }
        }

        return data;
    } catch (error) {
        console.error(`Failed to fetch ${stationId}/${dateStr}:`, error);
        return null;
    }
}

// Build search index from a schedule
function buildSearchIndex(stationId, dateStr, scheduleData) {
    if (!scheduleData || !scheduleData.data || !scheduleData.data[0] || !scheduleData.data[0].data) {
        return;
    }

    const programmes = scheduleData.data[0].data;

    for (const prog of programmes) {
        const title = prog.title || (prog.container && prog.container.title) || '';
        const synopsis = (prog.synopses && (prog.synopses.short || prog.synopses.medium || prog.synopses.long)) || '';
        const text = (title + ' ' + synopsis).toLowerCase();
        const words = text.split(/\s+/);

        const cacheKey = `${stationId}:${dateStr}`;

        for (const word of words) {
            if (word.length > 2) {
                if (!searchIndex.has(word)) {
                    searchIndex.set(word, new Set());
                }
                searchIndex.get(word).add(`${cacheKey}|${prog.start || ''}`);
            }
        }
    }
}

// Prefetch all station schedules
async function prefetchAll() {
    if (prefetchComplete) return;

    const now = new Date();
    const dateRange = [];

    // Calculate date range: 2 days ago to 7 days ahead
    for (let daysOffset = -2; daysOffset <= 7; daysOffset++) {
        const date = new Date(now);
        date.setDate(now.getDate() + daysOffset);
        dateRange.push(getFormattedDate(date));
    }

    totalEndpoints = STATIONS.length * dateRange.length;
    fetchedEndpoints = 0;

    // Generate all fetch tasks
    const tasks = [];
    for (const station of STATIONS) {
        for (const dateStr of dateRange) {
            tasks.push({ stationId: station.id, dateStr });
        }
    }

    // Fetch in chunks to respect connection limits
    for (let i = 0; i < tasks.length; i += CONCURRENT_LIMIT) {
        const chunk = tasks.slice(i, i + CONCURRENT_LIMIT);

        await Promise.all(
            chunk.map(async ({ stationId, dateStr }) => {
                const data = await fetchWithCache(stationId, dateStr);
                if (data) {
                    buildSearchIndex(stationId, dateStr, data);
                }
                fetchedEndpoints++;
                self.postMessage({
                    type: 'progress',
                    fetched: fetchedEndpoints,
                    total: totalEndpoints,
                    percent: Math.round((fetchedEndpoints / totalEndpoints) * 100)
                });
            })
        );

        // Small delay between chunks to avoid overwhelming the proxy
        if (i + CONCURRENT_LIMIT < tasks.length) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }

    prefetchComplete = true;
    self.postMessage({ type: 'complete' });
}

// Search using the cached data and search index
function searchCache(query) {
    if (!query || query.length < 2) return [];

    const searchLower = query.toLowerCase().trim();

    // If we have a populated search index, use it for faster lookups
    if (searchIndex.size > 0) {
        // Collect matching programme keys from index
        const keys = new Set();

        // Simple substring search using index
        const words = searchLower.split(/\s+/).filter(w => w.length > 1);

        if (words.length === 1) {
            // Single word - use index prefix matching
            for (const [term, keySet] of searchIndex) {
                if (term.includes(words[0])) {
                    keySet.forEach(key => keys.add(key));
                }
            }
        } else {
            // Multiple words - find intersection
            const termKeys = [];
            for (const word of words) {
                const wordKeys = new Set();
                for (const [term, keySet] of searchIndex) {
                    if (term.includes(word)) {
                        keySet.forEach(key => wordKeys.add(key));
                    }
                }
                if (wordKeys.size > 0) {
                    termKeys.push(wordKeys);
                }
            }

            // Find intersection of all word matches
            if (termKeys.length > 0) {
                const [first, ...rest] = termKeys;
                first.forEach(key => {
                    if (rest.every(set => set.has(key))) {
                        keys.add(key);
                    }
                });
            }
        }

        // Build results from keys
        const now = Date.now();
        const results = [];
        const seen = new Set();

        for (const key of keys) {
            const [cacheKey, start] = key.split('|');
            const [stationId, dateStr] = cacheKey.split(':');

            const cached = cache.get(cacheKey);
            if (!cached || !cached.data?.data?.[0]?.data) continue;

            const programmes = cached.data.data[0].data;
            for (const prog of programmes) {
                const progStart = prog.start;
                if (progStart !== start) continue;

                const progKey = `${stationId}|${progStart}`;
                if (seen.has(progKey)) continue;
                seen.add(progKey);

                const title = prog.title || (prog.container && prog.container.title) || '';
                const synopsis = (prog.synopses && (prog.synopses.short || prog.synopses.medium)) || '';

                // Filter by query again for accuracy
                if (title.toLowerCase().includes(searchLower) ||
                    synopsis.toLowerCase().includes(searchLower)) {

                    const station = STATIONS.find(s => s.id === stationId);
                    const startDate = progStart ? new Date(progStart) : null;

                    results.push({
                        ...prog,
                        station_id: stationId,
                        station_name: station?.name || stationId,
                        date_str: dateStr ? formatDateDisplay(new Date(dateStr)) : ''
                    });
                }
            }
        }

        // Sort by start time
        results.sort((a, b) => {
            const aDate = a.start ? new Date(a.start) : new Date(0);
            const bDate = b.start ? new Date(b.start) : new Date(0);
            return aDate - bDate;
        });

        return results;
    }

    // Fallback: iterate through all cache (for partial cache)
    const now = new Date();
    const results = [];
    const seen = new Set();

    for (const [cacheKey, cached] of cache) {
        if (!cached.data?.data?.[0]?.data) continue;

        const [stationId, dateStr] = cacheKey.split(':');
        const station = STATIONS.find(s => s.id === stationId);
        const programmes = cached.data.data[0].data;

        for (const prog of programmes) {
            const progKey = `${stationId}|${prog.start}`;
            if (seen.has(progKey)) continue;
            seen.add(progKey);

            const title = prog.title || (prog.container && prog.container.title) || '';
            const synopsis = (prog.synopses && (prog.synopses.short || prog.synopses.medium)) || '';

            if (title.toLowerCase().includes(searchLower) ||
                synopsis.toLowerCase().includes(searchLower)) {

                results.push({
                    ...prog,
                    station_id: stationId,
                    station_name: station?.name || stationId,
                    date_str: dateStr ? formatDateDisplay(new Date(dateStr)) : ''
                });
            }
        }
    }

    // Sort by start time
    results.sort((a, b) => {
        const aDate = a.start ? new Date(a.start) : new Date(0);
        const bDate = b.start ? new Date(b.start) : new Date(0);
        return aDate - bDate;
    });

    return results;
}

// Format date for display (e.g., "06 Feb 2026")
function formatDateDisplay(date) {
    const options = { day: '2-digit', month: 'short', year: 'numeric' };
    return date.toLocaleDateString('en-GB', options);
}

// Handle messages from main thread
self.onmessage = async (e) => {
    const { type, query, stationId, dateStr, initCache, data, timestamp } = e.data;

    if (type === 'initCache') {
        // Load cache from localStorage (passed from main thread)
        if (initCache) {
            for (const [key, entry] of Object.entries(initCache)) {
                // Only accept non-expired entries (10 hours)
                if (Date.now() - entry.timestamp < CACHE_DURATION) {
                    cache.set(key, entry);
                }
            }
        }
        // Worker is ready to serve requests
        self.postMessage({ type: 'cacheReady' });
    } else if (type === 'cacheSchedule') {
        // Cache schedule fetched directly by main thread
        const cacheKey = `${stationId}:${dateStr}`;
        const cacheEntry = { data, timestamp };
        cache.set(cacheKey, cacheEntry);
        // Build search index for this schedule
        buildSearchIndex(stationId, dateStr, data);
    } else if (type === 'prefetch') {
        await prefetchAll();
    } else if (type === 'search') {
        const results = searchCache(query);
        self.postMessage({ type: 'results', results });
    } else if (type === 'getSchedule') {
        // Return cached schedule for specific station/date
        const cacheKey = `${stationId}:${dateStr}`;
        const cached = cache.get(cacheKey);
        if (cached && cached.data?.data?.[0]?.data) {
            self.postMessage({
                type: 'schedule',
                stationId,
                dateStr,
                programmes: cached.data.data[0].data
            });
        } else {
            // Schedule not in cache yet, trigger fetch
            const data = await fetchWithCache(stationId, dateStr);
            if (data && data.data?.[0]?.data) {
                buildSearchIndex(stationId, dateStr, data);
                self.postMessage({
                    type: 'schedule',
                    stationId,
                    dateStr,
                    programmes: data.data[0].data
                });
            } else {
                self.postMessage({
                    type: 'schedule',
                    stationId,
                    dateStr,
                    programmes: []
                });
            }
        }
    } else if (type === 'getCacheStatus') {
        self.postMessage({
            type: 'cacheStatus',
            complete: prefetchComplete,
            fetched: fetchedEndpoints,
            total: totalEndpoints
        });
    }
};
