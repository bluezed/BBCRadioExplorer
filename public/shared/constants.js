/**
 * BBC Radio Explorer - Shared Constants
 * Copyright (c) 2026 Thomas Geppert
 * BSD 3-Clause License
 */

// Application Configuration
const APP_NAME = 'bbcRadioExplorer';
const APP_VERSION = '1.0.4';

// API Configuration
const PROXY_BASE_URL = 'http://your.cors-proxy.here:12345/proxy?url=';
const CACHE_DURATION = 36000 * 1000; // 10 hours

// Station definitions
const STATIONS = [
    { id: 'bbc_radio_one', name: 'BBC Radio 1' },
    { id: 'bbc_radio_two', name: 'BBC Radio 2' },
    { id: 'bbc_radio_three', name: 'BBC Radio 3' },
    { id: 'bbc_radio_fourfm', name: 'BBC Radio 4' },
    { id: 'bbc_radio_five_live', name: 'BBC Radio 5 Live' },
    { id: 'bbc_6music', name: 'BBC Radio 6 Music' },
    { id: 'bbc_radio_one_dance', name: 'BBC Radio 1 Dance' },
    { id: 'bbc_1xtra', name: 'BBC Radio 1Xtra' },
    { id: 'bbc_asian_network', name: 'BBC Asian Network' }
];

// Radio-Browser API URLs
const RADIO_BROWSER_SERVERS_URL = 'http://all.api.radio-browser.info/json/servers';
const RADIO_BROWSER_STATIONS_ENDPOINT = '/json/stations/search?name=';
const RADIO_BROWSER_CLICK_ENDPOINT = '/json/url/';
const RADIO_BROWSER_FALLBACK_URL = 'https://de1.api.radio-browser.info';
