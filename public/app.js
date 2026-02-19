/**
 * BBC Radio Explorer
 * Copyright (c) 2026 Thomas Geppert
 * BSD 3-Clause License
 */

// All constants are defined in shared/constants.js

// Application State
let state = {
    currentStation: STATIONS[0],
    currentDate: new Date(),
    programmes: [],
    searchQuery: '',
    isTableView: false, // Default to grid view
    lastRequestId: 0, // Track pending requests to avoid race conditions
    searchRequestId: 0, // Track current search request for worker responses
    isPlaying: false,
    audioPlayer: null,
    currentStreamUrl: null,
    hlsPlayer: null, // HLS.js player instance
    currentStreamAvailable: false // Is a stream available for current station?
};

// Web Worker for background search caching
let searchWorker = null;
let searchWorkerReady = false;
let workerCacheReady = false;
let playBtn = null;
let mobilePlayBtn = null;
let radioBrowserBaseUrl = null; // Cached radio-browser API URL

// Initialize Web Worker
function initSearchWorker() {
    try {
        searchWorker = new Worker('search-worker.js');
        searchWorker.onmessage = handleWorkerMessage;
        searchWorker.onerror = (e) => {
            console.error('Search worker error:', e);
        };

        // Load cached schedules from localStorage and send to worker
        const cached = loadCachedSchedules();

        if (cached && Object.keys(cached).length > 0) {
            // Has cached data - send to worker, will call fetchSchedule on cacheReady
            searchWorker.postMessage({ type: 'initCache', initCache: cached });
        } else {
            // No cached data - send empty init to trigger cacheReady immediately
            searchWorker.postMessage({ type: 'initCache', initCache: null });
        }

        // Start prefetching all schedules in background
        searchWorker.postMessage({ type: 'prefetch' });
        searchWorkerReady = true;
    } catch (e) {
        console.error('Failed to initialize search worker:', e);
    }
}

// Load cached schedules from localStorage
function loadCachedSchedules() {
    try {
        const stored = localStorage.getItem('bbc-radio-schedules');
        if (stored) {
            return JSON.parse(stored);
        }
    } catch (e) {
        // Ignore cache load errors
    }
    return null;
}

// Save schedule to localStorage
function saveScheduleToCache(stationId, dateStr, data, timestamp) {
    try {
        const key = `${stationId}:${dateStr}`;
        const cached = loadCachedSchedules() || {};
        cached[key] = { data, timestamp };
        localStorage.setItem('bbc-radio-schedules', JSON.stringify(cached));
    } catch (e) {
        // Ignore cache save errors
    }
}

// Handle messages from search worker
function handleWorkerMessage(e) {
    const { type, results, percent, stationId, dateStr, data, timestamp } = e.data;

    if (type === 'scheduleCached') {
        // Persist to localStorage
        saveScheduleToCache(stationId, dateStr, data, timestamp);
        return;
    }

    if (type === 'cacheReady') {
        workerCacheReady = true;
        // Now safe to fetch schedule (cache is loaded)
        // Check if current schedule is already cached
        const dateStr = getFormattedDate(state.currentDate);
        const cached = loadCachedSchedules();
        const hasCurrentDate = cached && cached[`${state.currentStation.id}:${dateStr}`];

        if (hasCurrentDate) {
            // Current date is cached - fetch via worker for consistency
            fetchSchedule();
        } else {
            // Current date NOT in cache - fetch directly to populate it immediately
            fetchCurrentScheduleDirect();
        }
        checkStreamAvailability();
        return;
    }

    if (type === 'progress') {
        // Update cache progress indicator
        const progressEl = document.getElementById('cache-progress');
        if (progressEl) {
            progressEl.textContent = `Caching schedules: ${percent}%`;
            progressEl.style.display = 'block';
        }
    } else if (type === 'complete') {
        const progressEl = document.getElementById('cache-progress');
        if (progressEl) {
            progressEl.textContent = 'Search cache ready';
            setTimeout(() => {
                progressEl.style.display = 'none';
            }, 2000);
        }
    } else if (type === 'results') {
        // Handle search results
        if (results && results.length > 0) {
            state.programmes = results;
            loadingTextEl.textContent = `Found ${results.length} results`;
            showState('content');
            renderSchedule(true);
        } else {
            showState('no-results');
        }
        loadingTextEl.textContent = 'Fetching schedule...';
    }
}

// Get radio-browser API URL (random server from list)
async function getRadioBrowserBaseUrl() {
    // Return cached URL if available
    if (radioBrowserBaseUrl) return radioBrowserBaseUrl;

    try {
        const response = await fetch(RADIO_BROWSER_SERVERS_URL, {
            headers: { 'User-Agent': `${APP_NAME}/${APP_VERSION}` }
        });
        const servers = await response.json();

        // Pick random server and cache it
        const randomServer = servers[Math.floor(Math.random() * servers.length)];
        radioBrowserBaseUrl = 'https://' + randomServer.name;

        return radioBrowserBaseUrl;
    } catch (error) {
        console.error('Failed to fetch radio-browser servers:', error);
        // Fallback to a known good server
        return RADIO_BROWSER_FALLBACK_URL;
    }
}

// Check if stream is available for current station
async function checkStreamAvailability() {
    const stationName = state.currentStation.name;

    // Show mobile play button during loading
    if (mobilePlayBtn) {
        mobilePlayBtn.classList.remove('hidden');
        mobilePlayBtn.classList.add('disabled');
        const span = mobilePlayBtn.querySelector('span:last-child');
        if (span) span.textContent = 'Checking...';
    }

    try {
        const apiUrl = await getRadioBrowserBaseUrl();
        const response = await fetch(`${apiUrl}${RADIO_BROWSER_STATIONS_ENDPOINT}${encodeURIComponent(stationName)}`, {
            headers: { 'User-Agent': `${APP_NAME}/${APP_VERSION}` }
        });
        const stations = await response.json();

        // Find BBC station from UK
        const bbcStations = stations.filter(s =>
            s.name.toLowerCase().includes(stationName.toLowerCase()) &&
            s.countrycode === 'GB'
        );

        // Check if any stream is available
        const hasStream = bbcStations.length > 0 && bbcStations.some(s => s.url_resolved);
        state.currentStreamAvailable = hasStream;

        // Remove loading state and update UI
        if (playBtn) {
            playBtn.classList.remove('loading');
        }
        updatePlayButtonUI();

        return hasStream;
    } catch (error) {
        console.error('Failed to check stream availability:', error);
        state.currentStreamAvailable = false;
        if (playBtn) {
            playBtn.classList.remove('loading');
        }
        updatePlayButtonUI();
        return false;
    }
}

// Track station click with radio-browser for popularity
async function trackStationClick(stationUuid) {
    if (!radioBrowserBaseUrl) return;

    try {
        await fetch(`${radioBrowserBaseUrl}${RADIO_BROWSER_CLICK_ENDPOINT}${stationUuid}`, {
            headers: { 'User-Agent': `${APP_NAME}/${APP_VERSION}` }
        });
    } catch (error) {
        // Silently fail - tracking is not critical
        console.warn('Failed to track station click:', error);
    }
}

// Play/pause live stream
async function playStream() {
    if (state.isPlaying) {
        // Pause
        if (state.audioPlayer) {
            state.audioPlayer.pause();
        }
        state.isPlaying = false;
        updatePlayButtonUI();
        return;
    }

    try {
        // Fetch stream URL from radio-browser.info
        const stationName = state.currentStation.name;
        const apiUrl = await getRadioBrowserBaseUrl();
        const response = await fetch(`${apiUrl}${RADIO_BROWSER_STATIONS_ENDPOINT}${encodeURIComponent(stationName)}`, {
            headers: { 'User-Agent': `${APP_NAME}/${APP_VERSION}` }
        });
        const stations = await response.json();

        // Find BBC station from UK - prefer MP3/AAC over HLS
        const bbcStations = stations.filter(s =>
            s.name.toLowerCase().includes(stationName.toLowerCase()) &&
            s.countrycode === 'GB'
        );

        // Prefer direct MP3/AAC streams over HLS
        let bbcStation = bbcStations.find(s =>
            (s.codec === 'MP3' || s.codec === 'AAC') && !s.url_resolved?.endsWith('.m3u8')
        );

        // Fallback to any direct stream
        if (!bbcStation) {
            bbcStation = bbcStations.find(s => !s.url_resolved?.endsWith('.m3u8'));
        }

        // Last resort: try HLS
        if (!bbcStation && bbcStations.length > 0) {
            bbcStation = bbcStations[0];
        }

        if (bbcStation?.url_resolved) {
            // Track station click for popularity
            if (bbcStation.stationuuid) {
                trackStationClick(bbcStation.stationuuid);
            }

            // Stop any existing playback
            stopPlayback();

            state.currentStreamUrl = bbcStation.url_resolved;

            // Check if HLS.js is available and stream is HLS
            if (Hls.isSupported() && bbcStation.url_resolved.endsWith('.m3u8')) {
                // Use hls.js for HLS streams
                const audio = document.createElement('audio');
                state.audioPlayer = audio;

                state.hlsPlayer = new Hls();
                state.hlsPlayer.loadSource(bbcStation.url_resolved);
                state.hlsPlayer.attachMedia(audio);

                state.hlsPlayer.on(Hls.Events.MANIFEST_PARSED, () => {
                    audio.play().catch(e => console.error('HLS play error:', e));
                });

                state.hlsPlayer.on(Hls.Events.ERROR, (_, data) => {
                    console.error('HLS error:', data);
                });
            } else {
                // Use native Audio for direct streams
                state.audioPlayer = new Audio(state.currentStreamUrl);
                state.audioPlayer.play();
            }

            state.isPlaying = true;
            updatePlayButtonUI();
        } else {
            alert('Stream not found for this station');
        }
    } catch (error) {
        console.error('Failed to fetch stream:', error);
        alert('Failed to load stream');
    }
}

function updatePlayButtonUI() {
    if (playBtn && playBtn.classList.contains('loading')) {
        // Still loading - don't update yet
        return;
    }

    // Update desktop play button
    if (playBtn) {
        const playIcon = playBtn.querySelector('.play-icon');
        const playLabel = playBtn.querySelector('.play-label');

        if (!state.currentStreamAvailable) {
            if (playIcon) playIcon.textContent = '▶';
            if (playLabel) playLabel.textContent = 'Unavailable';
            playBtn.classList.remove('playing');
            playBtn.classList.add('disabled');
            playBtn.title = 'Stream not available';
        } else if (state.isPlaying) {
            if (playIcon) playIcon.textContent = '⏸';
            if (playLabel) playLabel.textContent = 'Stop';
            playBtn.classList.add('playing');
            playBtn.classList.remove('disabled');
            playBtn.title = 'Stop streaming';
        } else {
            if (playIcon) playIcon.textContent = '▶';
            if (playLabel) playLabel.textContent = 'Listen Live';
            playBtn.classList.remove('playing');
            playBtn.classList.remove('disabled');
            playBtn.title = 'Play live stream';
        }
    }

    // Update mobile play button
    if (mobilePlayBtn) {
        const span = mobilePlayBtn.querySelector('span:last-child');

        if (!state.currentStreamAvailable) {
            mobilePlayBtn.classList.add('disabled');
            mobilePlayBtn.classList.remove('playing');
            mobilePlayBtn.title = 'Stream not available';
            if (span) span.textContent = 'Unavailable';
        } else if (state.isPlaying) {
            mobilePlayBtn.classList.add('playing');
            mobilePlayBtn.classList.remove('disabled');
            mobilePlayBtn.title = 'Stop streaming';
            if (span) span.textContent = 'Stop';
        } else {
            mobilePlayBtn.classList.remove('playing');
            mobilePlayBtn.classList.remove('disabled');
            mobilePlayBtn.title = 'Play live stream';
            if (span) span.textContent = 'Listen Live';
        }
    }
}

function stopPlayback() {
    // Remove any orphaned audio elements from body
    document.querySelectorAll('audio[data-orphan]').forEach(el => el.remove());

    // Stop HLS player first
    if (state.hlsPlayer) {
        state.hlsPlayer.stopLoad();
        state.hlsPlayer.detachMedia();
        state.hlsPlayer.destroy();
        state.hlsPlayer = null;
    }

    // Stop and cleanup audio player
    if (state.audioPlayer) {
        state.audioPlayer.pause();
        state.audioPlayer.src = '';
        state.audioPlayer.load();

        // Mark as orphan and add to body briefly for cleanup, then remove
        state.audioPlayer.setAttribute('data-orphan', 'true');
        document.body.appendChild(state.audioPlayer);
        document.body.removeChild(state.audioPlayer);
        state.audioPlayer = null;
    }

    state.isPlaying = false;
    state.currentStreamUrl = null;
    updatePlayButtonUI();
}

// UI Elements
const stationListEl = document.getElementById('station-list');
const scheduleContainerEl = document.getElementById('schedule-container');
const currentDateDisplayEl = document.getElementById('current-date-display');
const currentStationNameEl = document.getElementById('current-station-name');
const stationLogoHeaderEl = document.getElementById('station-logo-header');
const searchInputEl = document.getElementById('search-input');
const searchClearBtn = document.getElementById('search-clear');
const loadingStateEl = document.getElementById('loading-state');
const loadingTextEl = document.getElementById('loading-text');
const errorStateEl = document.getElementById('error-state');
const errorMessageEl = document.getElementById('error-message');
const noResultsEl = document.getElementById('no-results');
const prevDayBtn = document.getElementById('prev-day');
const nextDayBtn = document.getElementById('next-day');
const todayBtn = document.getElementById('today-btn');
const retryBtn = document.getElementById('retry-btn');

const viewTableBtn = document.getElementById('view-table-btn');
const viewGridBtn = document.getElementById('view-grid-btn');

// Mobile view toggle elements (deprecated - using desktop ones now)
const viewTableBtnMobile = null;
const viewGridBtnMobile = null;

// Floating search elements (deprecated - using header search now)
const searchFloatBtn = null;
const searchFloatPanel = null;
const searchFloatInput = null;
const searchFloatClear = null;
const searchFloatClose = null;

// Modal elements
const modalEl = document.getElementById('prog-modal');
const modalBackdrop = modalEl?.querySelector('.modal-backdrop');
const modalClose = modalEl?.querySelector('.modal-close');
const modalStationTag = document.getElementById('modal-station-tag');
const modalDate = document.getElementById('modal-date');
const modalTitle = document.getElementById('modal-title');
const modalTime = document.querySelector('.modal-time');
const modalSynopsis = document.querySelector('.modal-synopsis');
const modalGotoBtn = document.getElementById('modal-goto-btn');

let selectedProgramme = null;
let searchTimeout = null;

// Modal Functions
function openModal(prog) {
    if (!modalEl) return;

    selectedProgramme = prog;

    const isFromSearch = !!prog.station_name || !!prog.date_str;
    const stationName = prog.station_name || state.currentStation.name;
    const stationDate = prog.date_str || formatDateDisplay(state.currentDate);

    // Use local time since API returns UK time
    const startDate = prog.start ? new Date(prog.start) : null;
    const endDate = prog.end ? new Date(prog.end) : null;
    const startTime = startDate ? `${String(startDate.getHours()).padStart(2, '0')}:${String(startDate.getMinutes()).padStart(2, '0')}` : '--:--';
    const endTime = endDate ? `${String(endDate.getHours()).padStart(2, '0')}:${String(endDate.getMinutes()).padStart(2, '0')}` : '--:--';
    const synopsis = (prog.synopses && (prog.synopses.short || prog.synopses.medium || prog.synopses.long)) || 'No description available.';

    modalStationTag.textContent = stationName;
    modalDate.textContent = stationDate;
    modalTitle.textContent = prog.title || (prog.container && prog.container.title) || 'Untitled';
    modalTime.textContent = `${startTime} - ${endTime}`;
    modalSynopsis.textContent = synopsis;

    // Show/hide "Go to" button based on whether it's from search
    if (isFromSearch) {
        modalGotoBtn.textContent = 'Go to this programme';
        modalGotoBtn.style.display = 'inline-block';
    } else {
        modalGotoBtn.textContent = 'Close';
        modalGotoBtn.style.display = 'inline-block';
    }

    modalEl.classList.remove('hidden');
}

function closeModal() {
    if (!modalEl) return;
    modalEl.classList.add('hidden');
    selectedProgramme = null;
}

// Initialization
function init() {
    // Load saved view preference
    const savedView = localStorage.getItem('bbc-radio-view');
    if (savedView !== null) {
        state.isTableView = savedView === 'table';
    }
    updateViewToggleUI();

    // Initialize search worker for background caching
    initSearchWorker();

    renderStations();
    updateDateDisplay();
    // fetchSchedule() will be called when worker cache is ready
    checkStreamAvailability(); // Check if stream is available for initial station

    // Event Listeners
    prevDayBtn.addEventListener('click', () => {
        state.currentDate.setDate(state.currentDate.getDate() - 1);
        updateDateDisplay();
        fetchSchedule();
    });

    nextDayBtn.addEventListener('click', () => {
        state.currentDate.setDate(state.currentDate.getDate() + 1);
        updateDateDisplay();
        fetchSchedule();
    });

    todayBtn.addEventListener('click', () => {
        state.currentDate = new Date();
        updateDateDisplay();
        fetchSchedule();
    });

    searchInputEl.addEventListener('input', (e) => {
        state.searchQuery = e.target.value.toLowerCase();

        // Toggle clear button - remove hidden class
        if (state.searchQuery.length > 0) {
            searchClearBtn.classList.remove('hidden');
        } else {
            searchClearBtn.classList.add('hidden');
        }

        if (state.searchQuery) {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => {
                fetchGlobalSearch();
            }, 800);
        } else {
            fetchSchedule();
        }
    });

    searchClearBtn.addEventListener('click', () => {
        state.searchQuery = '';
        searchInputEl.value = '';
        searchClearBtn.classList.add('hidden');
        fetchSchedule();
    });

    // Play/pause live stream
    playBtn = document.getElementById('play-btn');
    mobilePlayBtn = document.getElementById('mobile-play-btn');

    const handlePlayClick = (e) => {
        e.stopPropagation();
        if (!state.currentStreamAvailable) {
            alert('Stream not available for this station');
            return;
        }
        // Toggle play/stop based on current state
        if (state.isPlaying) {
            // Stop playback completely (cleans up HLS player and network)
            stopPlayback();
        } else {
            // Play
            playStream();
        }
    };

    if (playBtn) {
        playBtn.addEventListener('click', handlePlayClick);
    }

    if (mobilePlayBtn) {
        mobilePlayBtn.addEventListener('click', handlePlayClick);
    }

    // Floating search: focus header search input
    if (searchFloatBtn) {
        searchFloatBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            searchInputEl?.focus();
        });
    }

    // Floating search: sync input with main search (for backwards compatibility)
    if (searchFloatInput) {
        searchFloatInput.addEventListener('input', (e) => {
            const value = e.target.value.toLowerCase();
            state.searchQuery = value;
            searchInputEl.value = e.target.value;

            // Toggle clear button - remove hidden class
            if (value.length > 0) {
                searchFloatClear.classList.remove('hidden');
                searchClearBtn.classList.remove('hidden');
            } else {
                searchFloatClear.classList.add('hidden');
                searchClearBtn.classList.add('hidden');
            }

            if (value) {
                clearTimeout(searchTimeout);
                searchTimeout = setTimeout(() => fetchGlobalSearch(), 800);
            } else {
                fetchSchedule();
            }
        });

        searchFloatInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                if (state.searchQuery) {
                    fetchGlobalSearch();
                }
            }
            if (e.key === 'Escape') {
                searchFloatPanel.classList.remove('active');
            }
        });
    }

    // Floating search: clear button
    if (searchFloatClear) {
        searchFloatClear.addEventListener('click', (e) => {
            e.stopPropagation();
            state.searchQuery = '';
            searchFloatInput.value = '';
            searchInputEl.value = '';
            searchFloatClear.classList.add('hidden');
            searchClearBtn.classList.add('hidden');
            fetchSchedule();
        });
    }

    // Modal event listeners
    if (modalEl) {
        modalBackdrop?.addEventListener('click', (e) => {
            if (e.target === modalBackdrop) closeModal();
        });
        modalClose?.addEventListener('click', closeModal);
        modalGotoBtn?.addEventListener('click', (e) => {
            e.preventDefault();
            // If not from search, just close the modal
            if (!selectedProgramme || !selectedProgramme.date_str) {
                closeModal();
                return;
            }
            // From search - go to the programme
            const station = STATIONS.find(s => s.id === selectedProgramme.station_id);
            const progStart = selectedProgramme.start;
            if (station) {
                searchFloatPanel?.classList.remove('active');
                state.searchQuery = '';
                searchInputEl.value = '';
                if (searchFloatInput) searchFloatInput.value = '';
                searchClearBtn.classList.add('hidden');
                if (searchFloatClear) searchFloatClear.classList.add('hidden');
                state.currentStation = station;
                // Use the raw start date string to avoid parsing issues with formatted dates
                state.currentDate = progStart ? new Date(progStart.split('T')[0]) : new Date();
                currentStationNameEl.textContent = station.name;
                renderStations();
                updateDateDisplay();
                closeModal();

                // Fetch schedule then scroll to and highlight the programme
                fetchSchedule().then(() => {
                    setTimeout(() => {
                        // Find and scroll to the programme row/card
                        const nowPlayingElements = document.querySelectorAll('.now-playing');
                        nowPlayingElements.forEach(el => el.classList.remove('now-playing'));

                        // Look for the programme with matching start time
                        const allElements = document.querySelectorAll('.programme-card, .schedule-table tbody tr');
                        allElements.forEach(el => {
                            if (el.dataset && el.dataset.start === progStart) {
                                el.classList.add('programme-goto');
                                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            }
                        });
                    }, 100);
                });
            }
        });
    }

    viewTableBtn.addEventListener('click', () => {
        state.isTableView = true;
        localStorage.setItem('bbc-radio-view', 'table');
        updateViewToggleUI();
        renderSchedule();
    });

    viewGridBtn.addEventListener('click', () => {
        state.isTableView = false;
        localStorage.setItem('bbc-radio-view', 'grid');
        updateViewToggleUI();
        renderSchedule();
    });

    // Mobile view toggle handlers
    if (viewTableBtnMobile) {
        viewTableBtnMobile.addEventListener('click', () => {
            state.isTableView = true;
            updateViewToggleUI();
            renderSchedule();
        });
    }

    if (viewGridBtnMobile) {
        viewGridBtnMobile.addEventListener('click', () => {
            state.isTableView = false;
            updateViewToggleUI();
            renderSchedule();
        });
    }

    retryBtn.addEventListener('click', fetchSchedule);
}

function getLogoUrl(stationId) {
    return `logos/${stationId}.svg`;
}

function updateViewToggleUI() {
    if (state.isTableView) {
        viewTableBtn?.classList.add('active');
        viewGridBtn?.classList.remove('active');
        viewTableBtnMobile?.classList.add('active');
        viewGridBtnMobile?.classList.remove('active');
    } else {
        viewTableBtn?.classList.remove('active');
        viewGridBtn?.classList.add('active');
        viewTableBtnMobile?.classList.remove('active');
        viewGridBtnMobile?.classList.add('active');
    }
}

function renderStations() {
    stationListEl.innerHTML = '';
    STATIONS.forEach(station => {
        const li = document.createElement('li');
        li.className = `station-item ${state.currentStation.id === station.id ? 'active' : ''}`;

        const logo = document.createElement('img');
        logo.src = getLogoUrl(station.id);
        logo.className = 'side-station-logo';
        logo.alt = '';

        const name = document.createElement('span');
        name.textContent = station.name;

        li.appendChild(logo);
        li.appendChild(name);

        li.onclick = () => {
            if (state.currentStation.id === station.id) return;
            stopPlayback(); // Stop playback when changing station
            state.currentStation = station;
            currentStationNameEl.textContent = station.name;
            renderStations();
            fetchSchedule();
            checkStreamAvailability(); // Check if stream is available for new station
        };
        stationListEl.appendChild(li);
    });

    // Scroll to active station (desktop only - on mobile it can push stations off screen)
    // const activeStation = stationListEl.querySelector('.station-item.active');
    // if (activeStation) {
    //     activeStation.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    // }
}

function updateDateDisplay() {
    const options = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' };
    currentDateDisplayEl.textContent = state.currentDate.toLocaleDateString('en-GB', options);

    // Calculate date range limits (2 days ago to 7 days ahead)
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const minDate = new Date(now);
    minDate.setDate(minDate.getDate() - 2);
    const maxDate = new Date(now);
    maxDate.setDate(maxDate.getDate() + 7);

    // Hide prev/next buttons based on date range
    prevDayBtn.style.display = state.currentDate <= minDate ? 'none' : 'inline-block';
    nextDayBtn.style.display = state.currentDate >= maxDate ? 'none' : 'inline-block';

    // Hide today button if already on today
    todayBtn.style.display = state.currentDate.toDateString() === now.toDateString() ? 'none' : 'inline-block';
}

function getFormattedDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// Format date for display (e.g., "06 Feb 2026")
function formatDateDisplay(date) {
    const options = { day: '2-digit', month: 'short', year: 'numeric' };
    return date.toLocaleDateString('en-GB', options);
}

// Helpers for Data Fetching
// Global Search Implementation - fetches schedules across multiple days and filters locally
async function fetchGlobalSearch() {
    if (!state.searchQuery) return;

    const requestId = ++state.lastRequestId;
    showState('loading');
    loadingTextEl.textContent = 'Searching...';

    // Use worker for search if available
    if (searchWorker && searchWorkerReady) {
        state.searchRequestId = requestId;
        searchWorker.postMessage({ type: 'search', query: state.searchQuery });
        return;
    }

    // Fallback: use original fetch logic if worker not available
    try {
        const searchLower = state.searchQuery.toLowerCase();
        const now = new Date();
        const allMatches = [];

        // Calculate date range: from 2 days ago to 7 days from now
        const minDate = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
        const maxDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

        // Collect all fetch promises for all stations and date range
        const fetchPromises = [];

        // Fetch 10 days for each station (now-2 to now+7)
        for (let daysOffset = 0; daysOffset < 10; daysOffset++) {
            const searchDate = new Date(now);
            searchDate.setDate(now.getDate() - 2 + daysOffset);
            const dateStr = getFormattedDate(searchDate);

            STATIONS.forEach(station => {
                const promise = (async () => {
                    try {
                        const bbcUrl = `https://rms.api.bbc.co.uk/v2/experience/inline/schedules/${station.id}/${dateStr}`;
                        const proxyUrl = PROXY_BASE_URL + encodeURIComponent(bbcUrl);
                        const response = await fetch(proxyUrl);
                        if (!response.ok) return;
                        const data = await response.json();

                        if (data && data.data && data.data[0] && data.data[0].data) {
                            const programmes = data.data[0].data;

                            for (const prog of programmes) {
                                const title = prog.title || (prog.container && prog.container.title) || '';
                                const synopsis = (prog.synopses && (prog.synopses.short || prog.synopses.medium || prog.synopses.long)) || '';

                                // Check if title or synopsis matches search
                                if (title.toLowerCase().includes(searchLower) ||
                                    synopsis.toLowerCase().includes(searchLower)) {

                                    allMatches.push({
                                        ...prog,
                                        station_id: station.id,
                                        station_name: station.name,
                                        date_str: prog.start ? formatDateDisplay(new Date(prog.start)) : formatDateDisplay(searchDate)
                                    });
                                }
                            }
                        }
                    } catch (e) {
                        // Silently skip failed fetches
                    }
                })();
                fetchPromises.push(promise);
            });
        }

        // Wait for all fetches to complete
        await Promise.all(fetchPromises);

        // Skip if a newer request has started
        if (requestId !== state.lastRequestId) return;

        // Filter by date range
        const filteredMatches = allMatches.filter(match => {
            if (!match.start) return false;
            const matchDate = new Date(match.start);
            return matchDate >= minDate && matchDate <= maxDate;
        });

        // Deduplicate by station_id + start time (BBC lists midnight programmes on both days)
        const seen = new Set();
        const dedupedMatches = filteredMatches.filter(match => {
            const key = `${match.station_id}|${match.start}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        // Sort by start time (oldest first)
        dedupedMatches.sort((a, b) => {
            const dateA = a.start ? new Date(a.start).getTime() : 0;
            const dateB = b.start ? new Date(b.start).getTime() : 0;
            return dateA - dateB; // Oldest first
        });

        state.programmes = dedupedMatches;
        renderSchedule(true);
        showState('content');

    } catch (error) {
        console.error('Global search error:', error);
        if (requestId === state.lastRequestId) {
            errorMessageEl.textContent = `Search failed: ${error.message}`;
            showState('error');
        }
    } finally {
        loadingTextEl.textContent = 'Fetching schedule...';
    }
}

// Fetch current schedule directly (bypasses worker for immediate load)
async function fetchCurrentScheduleDirect() {
    const requestId = ++state.lastRequestId;
    const stationId = state.currentStation.id;
    const dateStr = getFormattedDate(state.currentDate);

    stationLogoHeaderEl.innerHTML = `<img src="${getLogoUrl(stationId)}" alt="${state.currentStation.name}">`;

    showState('loading');

    try {
        const bbcUrl = `https://rms.api.bbc.co.uk/v2/experience/inline/schedules/${stationId}/${dateStr}`;
        const proxyUrl = PROXY_BASE_URL + encodeURIComponent(bbcUrl);
        const response = await fetch(proxyUrl);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();

        // Skip if a newer request has started
        if (requestId !== state.lastRequestId) return;

        if (data.data && data.data[0] && data.data[0].data) {
            state.programmes = data.data[0].data;
        } else {
            state.programmes = [];
        }

        // Notify worker to cache this schedule
        if (searchWorker && searchWorkerReady) {
            searchWorker.postMessage({
                type: 'cacheSchedule',
                stationId,
                dateStr,
                data,
                timestamp: Date.now()
            });
        }

        renderSchedule();
        showState('content');
    } catch (error) {
        console.error('Fetch error:', error);
        if (requestId === state.lastRequestId) {
            errorMessageEl.textContent = `Failed to load schedule: ${error.message}`;
            showState('error');
        }
    }
}

async function fetchSchedule() {
    const requestId = ++state.lastRequestId;
    const stationId = state.currentStation.id;
    const dateStr = getFormattedDate(state.currentDate);

    stationLogoHeaderEl.innerHTML = `<img src="${getLogoUrl(stationId)}" alt="${state.currentStation.name}">`;

    // Always use global search when there's a query
    if (state.searchQuery) {
        return fetchGlobalSearch();
    }

    showState('loading');

    // Try worker cache first for instant load
    if (searchWorker && searchWorkerReady) {
        // Create a one-time handler for this schedule response
        const scheduleHandler = (e) => {
            const { type, stationId: respStationId, dateStr: respDateStr, programmes } = e.data;
            if (type === 'schedule' && respStationId === stationId && respDateStr === dateStr) {
                // Remove this handler
                searchWorker.onmessage = handleWorkerMessage;
                // Skip if a newer request has started
                if (requestId !== state.lastRequestId) return;
                state.programmes = programmes || [];
                renderSchedule();
                showState('content');
            }
        };

        searchWorker.onmessage = scheduleHandler;
        searchWorker.postMessage({ type: 'getSchedule', stationId, dateStr });
        return;
    }

    // Fallback: direct API call if worker not available
    try {
        const bbcUrl = `https://rms.api.bbc.co.uk/v2/experience/inline/schedules/${stationId}/${dateStr}`;
        const proxyUrl = PROXY_BASE_URL + encodeURIComponent(bbcUrl);
        const response = await fetch(proxyUrl);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();

        // Skip if a newer request has started
        if (requestId !== state.lastRequestId) return;

        if (data.data && data.data[0] && data.data[0].data) {
            state.programmes = data.data[0].data;
        } else {
            state.programmes = [];
        }

        renderSchedule();
        showState('content');
    } catch (error) {
        console.error('Fetch error:', error);
        // Only show error if this is still the current request
        if (requestId === state.lastRequestId) {
            errorMessageEl.textContent = `Failed to load schedule: ${error.message}`;
            showState('error');
        }
    }
}

function renderSchedule(isGlobal = false) {
    scheduleContainerEl.innerHTML = '';

    if (state.isTableView) {
        scheduleContainerEl.classList.remove('schedule-grid');
    } else {
        scheduleContainerEl.classList.add('schedule-grid');
    }

    let filtered = state.programmes;
    if (!isGlobal && !state.searchQuery) {
        // No search - show all programmes
        filtered = state.programmes;
    } else {
        // Global search results - already filtered
        filtered = state.programmes;
    }

    if (filtered.length === 0) {
        noResultsEl.classList.remove('hidden');
    } else {
        noResultsEl.classList.add('hidden');
    }

    if (state.isTableView) {
        renderTableView(filtered, isGlobal);
        return;
    }

    filtered.forEach(prog => {
        const card = document.createElement('div');
        card.className = 'programme-card';
        if (prog.start) card.dataset.start = prog.start;

        const title = prog.title || (prog.container && prog.container.title) || 'Untitled Programme';
        const synopsis = (prog.synopses && (prog.synopses.short || prog.synopses.medium)) || 'No description available.';

        let durationMins = 0;
        if (prog.start && prog.end) {
            durationMins = Math.round((new Date(prog.end) - new Date(prog.start)) / 60000);
        } else if (prog.duration) {
            // Search results have duration in milliseconds
            durationMins = Math.round(prog.duration / 60000);
        }

        let timeHtml = '';
        let tagsHtml = '';

        if (isGlobal || state.searchQuery) {
            // Search results: show date and station, time if available
            const stationName = prog.station_name || STATIONS.find(s => s.id === prog.station_id)?.name || prog.station_id;
            const dateStr = prog.date_str ? formatDateDisplay(new Date(prog.date_str)) : '';
            // Show actual time range when available (use local time since API returns UK time)
            const startDate = prog.start ? new Date(prog.start) : null;
            const endDate = prog.end ? new Date(prog.end) : null;
            const startTime = startDate ? `${String(startDate.getHours()).padStart(2, '0')}:${String(startDate.getMinutes()).padStart(2, '0')}` : '--:--';
            const endTime = endDate ? `${String(endDate.getHours()).padStart(2, '0')}:${String(endDate.getMinutes()).padStart(2, '0')}` : '--:--';
            const timeRange = prog.start ? `${startTime} - ${endTime}` : dateStr;

            tagsHtml = `
                <div class="station-date-tags">
                    <span class="station-tag">${stationName}</span>
                    <span class="date-tag">${dateStr}</span>
                </div>
            `;
            timeHtml = `<div class="prog-time">${timeRange}</div>`;
        } else {
            // Normal schedule: show start/end time
            const startTime = prog.start ? new Date(prog.start).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '--:--';
            const endTime = prog.end ? new Date(prog.end).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '--:--';
            timeHtml = `<div class="prog-time">${startTime} - ${endTime}</div>`;
        }

        card.innerHTML = `
            ${tagsHtml}
            ${timeHtml}
            <div class="prog-title">${title}</div>
            <div class="prog-desc">${synopsis}</div>
            <div class="prog-footer">
                <span class="duration">${durationMins > 0 ? durationMins + ' mins' : ''}</span>
            </div>
        `;

        if (isGlobal || state.searchQuery) {
            card.onclick = () => openModal(prog);
        } else {
            const now = new Date();
            const start = prog.start ? new Date(prog.start) : null;
            const end = prog.end ? new Date(prog.end) : null;
            const isToday = state.currentDate.toDateString() === now.toDateString();

            if (isToday && start && end && now >= start && now < end) {
                card.classList.add('now-playing');
                // Scroll schedule container so card is visible above fixed play button
                setTimeout(() => {
                    const container = scheduleContainerEl.parentElement;
                    const rect = card.getBoundingClientRect();
                    const containerRect = container.getBoundingClientRect();
                    // Target position: card should be near top of visible area
                    const targetTop = rect.top - containerRect.top - 60;
                    container.scrollTo({ top: targetTop, behavior: 'smooth' });
                }, 100);
            }
        }

        scheduleContainerEl.appendChild(card);
    });
}

function showState(s) {
    loadingStateEl.classList.toggle('hidden', s !== 'loading');
    errorStateEl.classList.toggle('hidden', s !== 'error');
    scheduleContainerEl.classList.toggle('hidden', s !== 'content');
    if (s === 'content' && state.programmes.length === 0) {
        noResultsEl.classList.remove('hidden');
    } else if (s !== 'content') {
        noResultsEl.classList.add('hidden');
    }
}

function renderTableView(programmes, isGlobal) {
    const tableWrapper = document.createElement('div');
    tableWrapper.className = 'schedule-table-wrapper';

    const table = document.createElement('table');
    table.className = 'schedule-table';

    const thead = document.createElement('thead');
    thead.innerHTML = `
        <tr>
            ${isGlobal || state.searchQuery ? '<th>Station</th><th>Date</th>' : ''}
            <th class="time-col">Time</th>
            <th class="title-col">Programme</th>
            <th class="desc-col">Description</th>
            <th class="duration-col">Duration</th>
        </tr>
    `;
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    programmes.forEach(prog => {
        const tr = document.createElement('tr');
        if (prog.start) tr.dataset.start = prog.start;

        const title = prog.title || (prog.container && prog.container.title) || 'Untitled Programme';
        const synopsis = (prog.synopses && (prog.synopses.short || prog.synopses.medium)) || 'No description available.';

        let durationMins = 0;
        if (prog.start && prog.end) {
            durationMins = Math.round((new Date(prog.end) - new Date(prog.start)) / 60000);
        } else if (prog.duration) {
            // Search results have duration in milliseconds
            durationMins = Math.round(prog.duration / 60000);
        }

        const now = new Date();
        const start = prog.start ? new Date(prog.start) : null;
        const end = prog.end ? new Date(prog.end) : null;
        const isToday = state.currentDate.toDateString() === now.toDateString();

        if (!isGlobal && !state.searchQuery && isToday && start && end && now >= start && now < end) {
            tr.classList.add('now-playing');
            // Scroll schedule container so row is visible above fixed play button
            setTimeout(() => {
                const container = tableWrapper;
                const rect = tr.getBoundingClientRect();
                const containerRect = container.getBoundingClientRect();
                // Target position: row should be near top of visible area
                const targetTop = container.scrollTop + rect.top - containerRect.top - 60;
                container.scrollTo({ top: targetTop, behavior: 'smooth' });
            }, 100);
        }

        let extraCols = '';
        let timeDisplay = '';

        if (isGlobal || state.searchQuery) {
            // Search results: show station and date, time column shows actual time
            const stationName = prog.station_name || STATIONS.find(s => s.id === prog.station_id)?.name || prog.station_id;
            const dateStr = prog.date_str ? formatDateDisplay(new Date(prog.date_str)) : '';
            // Show actual start time in time column (use local time since API returns UK time)
            const startDate = prog.start ? new Date(prog.start) : null;
            const startTime = startDate ? `${String(startDate.getHours()).padStart(2, '0')}:${String(startDate.getMinutes()).padStart(2, '0')}` : '--:--';
            extraCols = `<td>${stationName}</td><td>${dateStr}</td>`;
            timeDisplay = `<td class="time-col">${startTime}</td>`;

            tr.style.cursor = 'pointer';
            tr.onclick = () => openModal(prog);
        } else {
            // Normal schedule: click to open details modal
            const startTime = prog.start ? new Date(prog.start).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '--:--';
            timeDisplay = `<td class="time-col">${startTime}</td>`;
            tr.style.cursor = 'pointer';
            tr.onclick = () => openModal(prog);
        }

        tr.innerHTML = `
            ${extraCols}
            ${timeDisplay}
            <td class="title-col">${title}</td>
            <td class="desc-col" title="${synopsis}">${synopsis}</td>
            <td class="duration-col">${durationMins > 0 ? durationMins + ' min' : ''}</td>
        `;
        tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    tableWrapper.appendChild(table);
    scheduleContainerEl.appendChild(tableWrapper);
}

// Auto-update now-playing highlight every minute
let lastHighlightedStart = null;

function updateNowPlaying() {
    // Only update if viewing today's schedule (not search results)
    if (state.searchQuery) return;

    const now = new Date();
    const today = now.toDateString();
    const isToday = state.currentDate.toDateString() === today;

    if (!isToday) return;

    // Find the current programme
    let currentProg = null;
    for (const prog of state.programmes) {
        const start = prog.start ? new Date(prog.start) : null;
        const end = prog.end ? new Date(prog.end) : null;
        if (start && end && now >= start && now < end) {
            currentProg = prog;
            break;
        }
    }

    // Check if we need to update the highlight
    const newStart = currentProg?.start;
    if (newStart === lastHighlightedStart) return;
    lastHighlightedStart = newStart;

    // Remove old highlight
    document.querySelectorAll('.now-playing').forEach(el => {
        el.classList.remove('now-playing');
    });

    // Add new highlight
    if (currentProg) {
        const el = document.querySelector(`.programme-card[data-start="${currentProg.start}"], .schedule-table tbody tr[data-start="${currentProg.start}"]`);
        if (el) {
            el.classList.add('now-playing');
            el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }
}

// Reset scroll positions when page becomes visible (fixes bfcache scroll issues)
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
        // Reset main content scroll to top
        const mainContent = document.querySelector('.main-content');
        if (mainContent) {
            const scheduleSection = mainContent.querySelector('.schedule-section');
            if (scheduleSection) {
                scheduleSection.scrollTop = 0;
            }
        }
        // Reset station nav scroll
        const stationNav = document.querySelector('.station-nav');
        if (stationNav) {
            stationNav.scrollLeft = 0;
        }
    }
});

// Start polling for now-playing updates (every 30 seconds)
setInterval(updateNowPlaying, 30000);

init();
