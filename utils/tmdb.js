'use strict';

const Bottleneck = require('bottleneck');
// If using Node 18+ you can rely on the global fetch; if not, install 'node-fetch' and uncomment the next line.
// const fetch = require('node-fetch');

const TMDB_BEARER_TOKEN = process.env.TMDB_BEARER_TOKEN;
const TMDB_MOVIE_SEARCH_URL = 'https://api.themoviedb.org/3/search/movie';
const TMDB_TV_SEARCH_URL = 'https://api.themoviedb.org/3/search/tv';

// Global rate limiter for TMDB API calls -- 50 requests per second.
const tmdbLimiter = new Bottleneck({
    maxConcurrent: 50,
    minTime: 20
});

// TMDB search function wrapped in the global rate limiter.
async function searchTmdb(query, mediaType, year, metadata) {
    // For Formula 1, always search as a show ("tv")
    let actualMediaType = mediaType;
    let actualQuery = query;
    let actualYear = year;

    if (mediaType === 'sports-f1') {
        actualMediaType = 'shows'; // Always use TV search for F1
        // Optionally, override query for F1 if you want to always use "Formula 1"
        // actualQuery = 'Formula 1';
        if (metadata && metadata.f1 && metadata.f1.season) {
            actualYear = metadata.f1.season;
        }
    }

    return tmdbLimiter.schedule(async () => {
        const languages = ['hi-IN', 'en-US'];
        for (const lang of languages) {
            // Always use TV search URL for 'shows' and 'sports-f1'
            let baseUrl = actualMediaType === 'shows' ? TMDB_TV_SEARCH_URL : TMDB_MOVIE_SEARCH_URL;
            const urlObj = new URL(baseUrl);
            urlObj.searchParams.append('query', actualQuery);
            urlObj.searchParams.append('language', lang);
            urlObj.searchParams.append('include_adult', 'false');
            if (actualYear) {
                if (actualMediaType === 'shows') {
                    urlObj.searchParams.append('first_air_date_year', actualYear.toString());
                } else {
                    urlObj.searchParams.append('year', actualYear.toString());
                }
            }
            try {
                const response = await fetch(urlObj.href, {
                    headers: {
                        'Authorization': `Bearer ${TMDB_BEARER_TOKEN}`,
                        'Content-Type': 'application/json'
                    }
                });
                if (response.status === 502) {
                    throw new Error("API_DOWN");
                }
                if (!response.ok) {
                    throw new Error("HTTP_ERROR_" + response.status);
                }
                const data = await response.json();
                if (data.results && data.results.length > 0) {
                    let results = data.results;
                    if (actualYear) {
                        results = results.filter(item => {
                            const dateField = actualMediaType === 'shows' ? item.first_air_date : item.release_date;
                            return dateField && dateField.startsWith(actualYear.toString());
                        });
                    }
                    if (results.length > 0) {
                        return results[0].id;
                    } else if (data.results.length > 0) {
                        return data.results[0].id;
                    }
                }
            } catch (error) {
                throw error;
            }
        }
        return null;
    });
}

// TMDB details retrieval function wrapped in the global rate limiter.
async function getTmdbDetails(tmdbId, mediaType) {
    return tmdbLimiter.schedule(async () => {
        let baseUrl;
        if (mediaType === 'shows') {
            baseUrl = `https://api.themoviedb.org/3/tv/${tmdbId}`;
        } else {
            baseUrl = `https://api.themoviedb.org/3/movie/${tmdbId}`;
        }
        try {
            const response = await fetch(baseUrl, {
                headers: {
                    'Authorization': `Bearer ${TMDB_BEARER_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            });
            if (!response.ok) {
                console.error(`Failed to fetch TMDB details for id ${tmdbId} with status ${response.status}`);
                return null;
            }
            return await response.json();
        } catch (error) {
            console.error(`Error fetching TMDB details for id ${tmdbId}:`, error);
            return null;
        }
    });
}

module.exports = {
    searchTmdb,
    getTmdbDetails,
    tmdbLimiter
};