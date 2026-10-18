# Trip Weather

A mobile-first web app that shows day-by-day weather forecasts for every stop on a trip. Plain HTML, CSS and JavaScript: no build step, no backend, no API key. Forecasts come from [Open-Meteo](https://open-meteo.com/).

Live site (once deployed): **https://dkalb21.github.io/travel-weather/**

## Run it locally

Either of these works:

- **Open the file:** double-click `index.html` (or drag it into a browser).
- **Local server:** from this folder run

  ```sh
  python3 -m http.server 8000
  ```

  then open <http://localhost:8000/>. The server route also enables the offline app shell (service worker), which browsers don't allow from `file://`.

All asset paths are relative, so the same files also work from a GitHub Pages subpath such as `/travel-weather/`.

## Add a city

1. Type a city name in **City**. A list of matches appears, each with its region and country (for example *Paris, Texas, United States* vs *Paris, Île-de-France, France*). Tap the right one.
2. Pick **Start** and **End** dates.
3. Tap **Add**.

Each city is a "stop". Stops are sorted by date. Use **Edit dates** to change a stop's dates or **Remove** to delete it (an **Undo** button appears briefly). **Clear all** removes every stop. Everything is saved in your browser's localStorage, so it survives reloads.

On first run the app preloads two sample stops (Lisbon and Tokyo, next 7 days). Clear them with **Clear all**; they won't come back.

### Reading the forecast

- Each day card shows the weather icon, a large orange **▲ High** and a large blue **▼ Low**, plus a vertical bar showing that day's range against the whole stop, so warmer and cooler days stand out.
- The chart above the cards plots highs and lows across the stop with every value labelled.
- If the chance of rain reaches **30%** or more, the card shows a rain badge with the peak chance, the hours at risk (e.g. `2–5 PM · peak 70%`), and a 24-bar hourly strip (midnight to midnight, in the city's local time). Below 30% you'll see a quiet "Dry". The threshold is the `RAIN_THRESHOLD` constant at the top of `app.js`.
- Rain colours go from light blue (unlikely) to deep blue (likely) everywhere.
- Dates are each city's local dates, using the city's time zone.
- Forecasts only reach about 16 days ahead. Days further out show "Forecast not available yet. Check back within 16 days" and fill in automatically once they're in range.
- **°F / °C** switches units. **Refresh** refetches every stop.

### Trip report

Tap **Trip report** (next to **By stop**) to see the whole trip in one list. It has one row per day, in date order across every stop. Each row shows the city, conditions, high and low, and the chance of rain. Rainy days are highlighted, and the color gets deeper as rain gets more likely:

- **Possible** means a 30–49% chance.
- **Likely** means 50–69%.
- **Very likely** means 70% or more.

The rain hours are listed beside each rainy day. The top of the report counts how many days fall in each band and points out the wettest, warmest and coolest days. The bands are set by `RAIN_SEVERITY` in `app.js`.

### Offline

The last successful forecast for each stop is saved on the device. If you're offline or a fetch fails, the app shows the saved forecast with a "Last updated …" time and an offline notice. One city failing never affects the others; each has its own **Retry** button.

## Move your trip to your phone (share link)

1. On your laptop, tap **Copy share link**. Your stops (city, coordinates, time zone and dates) are encoded in the link after `#trip=`. Nothing is uploaded anywhere.
2. Send the link to your phone (Messages, email, notes…) and open it.
3. If the phone has no stops yet, they're imported straight away. If it already has stops, you're asked to **Replace** them or **Merge** the two lists (duplicates are skipped).

## Add it to your phone's home screen

**iPhone / iPad (Safari)**
1. Open the site in Safari.
2. Tap the **Share** button (square with an up arrow).
3. Scroll down and tap **Add to Home Screen**, then **Add**.

**Android (Chrome)**
1. Open the site in Chrome.
2. Tap the **⋮** menu.
3. Tap **Add to Home screen** (or **Install app**), then **Add/Install**.

It then opens full screen from its own icon, like an app.

## Deploy to GitHub Pages

```sh
cd travel-weather
gh repo create travel-weather --public --source=. --remote=origin --push
gh api -X POST repos/{owner}/travel-weather/pages -f "source[branch]=main" -f "source[path]=/"
```

Or in the browser: create a public repo named `travel-weather`, push this folder to `main`, then go to **Settings → Pages → Build and deployment → Deploy from a branch → main / (root) → Save**. The site appears at `https://<your-username>.github.io/travel-weather/` after a minute or two.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page structure, meta tags for home-screen install |
| `style.css` | Mobile-first styles, light and dark mode |
| `app.js` | All app logic (search, storage, fetching, rendering, share links) |
| `manifest.webmanifest` | Web app manifest |
| `icon.svg` | App icon (PNG copies are included for iOS and Android) |
| `sw.js` | Small service worker so the app shell opens offline when served over http(s) |
