# BBC Radio Explorer

A web application for browsing BBC Radio schedules. Runs entirely in the browser without requiring a backend server.

## How to Run

1.  Navigate to the `public` folder.
2.  In [constants.js](shared/constants.js) edit the constant PROXY_BASE_URL and set a CORS Proxy url.
3.  Start a local server (required for Web Workers):
    - **Python**: `python -m http.server 8000`
    - **Node.js**: `npx serve`
    - or any other server you choose...
4.  Open `http://localhost:8000` in your browser.

**IMPORTANT**

> Since caching schedules requires multiple api queries
> any free public CORS proxy may rate limit or block requests.
> For production use, consider a paid CORS proxy service or
> hosting your own proxy (e.g., using a simple Node.js or Python server).


## Features

-   **Live Schedules**: Fetches real-time schedules from BBC API via a CORS proxy.
-   **Global Search**: Instant client-side search across all stations and 10 days (2 days ago to 7 days ahead).
-   **Background Caching**: Web Worker prefetches all schedules for instant search results.
-   **Two View Modes**: Toggle between table view and grid view.
-   **Responsive Design**: Optimized for both desktop and mobile devices.
-   **Programme Details**: Click any programme to view full description and start/end times.
-   **"Go to" Navigation**: From search results, navigate directly to any programme in its original schedule.
-   **Persistent Preferences**: View mode preference (table/grid) is saved in localStorage.

## Technical Details

-   **CORS Proxy**: Uses a custom CORS proxy (host your own or use a CORS proxy service) to bypass BBC API CORS restrictions.
-   **Caching**: In-memory caching (10 hour TTL) + Web Worker background prefetching.
-   **Search**: Local search using pre-built index - no API calls needed after initial cache.
-   **Local Timezone**: All times are displayed in local time.
-   **Web Worker**: Handles background fetching and search indexing for responsive UI.

## Supported Stations

- BBC Radio 1
- BBC Radio 2
- BBC Radio 3
- BBC Radio 4
- BBC Radio 5 Live
- BBC Radio 6 Music
- BBC Radio 1 Dance
- BBC Radio 1Xtra
- BBC Asian Network

## Screenshots

### Desktop

[![BBCRadio_Explorer_desktop.png](https://i.postimg.cc/bSvz7BDN/BBCRadio_Explorer_desktop.png)](https://postimg.cc/bSvz7BDN)

### Mobile

[![BBCRadio_Explorer_mobile.png](https://i.postimg.cc/ZvqTGMB5/BBCRadio_Explorer_mobile.png)](https://postimg.cc/ZvqTGMB5)

## License

BSD 3-Clause License. See [LICENSE](LICENSE) file for details.

## AI Disclosure & Responsibility

Note: Approximately 95% of this codebase was generated using MiniMax M2.5.

While the logic has been prompted and organized by a human maintainer, it may contain patterns, bugs, or inefficiencies unique to large language models. This project is provided "as-is" for educational purposes. Users are encouraged to conduct their own security and performance audits before using this code in a production environment.

## Disclaimer

This project is not affiliated with, endorsed by, or connected to the British Broadcasting Corporation (BBC). All BBC Radio content, branding, logos, and trademarks are the exclusive property of the BBC. This is an independent, open-source project created for educational and personal use.

Station logos are sourced from [Wikimedia Commons](https://commons.wikimedia.org/wiki/Category:BBC_Radio_station_logos) and are used under their respective licenses.
