'use strict';

function parseTitle(rawName) {
    // --- Step 1. Check for collection indicators ---
    // If the raw name contains "collection", "collections", or "bundle" (case insensitive),
    // mark type as "collection".
    let type = "";
    if (/\b(collection|collections|bundle)\b/i.test(rawName)) {
        type = "collection";
    }

    // --- Step 2. Check for TV-show keywords ---
    // Look for common TV show indicators:
    // e.g., "season", or patterns like "S01" or "S01E02"
    const tvShowRegex = /\b(season|\bs\d{1,2}(?:e\d{1,2})?)\b/i;
    let tvShowIndex = rawName.search(tvShowRegex);
    if (tvShowIndex !== -1) {
        type = "shows";
    }

    // --- Step 3. Extract the Year ---
    // We search for a four-digit number starting with 19 or 20. We use matchAll to pick all candidates.
    const regexYear = /\b(19|20)\d{2}\b/g;
    const lowerBound = 1900;
    const upperBound = 2030;
    let parsedYear = null;
    let yearIndex = Infinity; // we'll choose the leftmost valid occurrence

    for (const match of rawName.matchAll(regexYear)) {
        const candidate = match[0];
        const candidateNum = parseInt(candidate, 10);
        if (candidateNum >= lowerBound && candidateNum <= upperBound) {
            if (match.index < yearIndex) {
                yearIndex = match.index;
                parsedYear = candidate;
            }
        }
    }

    // --- Step 4. Set the cutoff for title extraction ---
    // We want the title only from the raw string up to (but not including) the TV-show keyword or the year,
    // whichever comes first.
    let cutoffIndex = rawName.length;
    if (tvShowIndex !== -1) {
        cutoffIndex = Math.min(cutoffIndex, tvShowIndex);
    }
    if (parsedYear !== null && yearIndex !== Infinity) {
        cutoffIndex = Math.min(cutoffIndex, yearIndex);
    }

    // Extract all text before the determined cutoff
    let titlePart = rawName.substring(0, cutoffIndex);
    // Remove any trailing punctuation or unmatched opening brackets/parentheses.
    titlePart = titlePart.replace(/[\(\[\{\.\-\s]+$/g, "");

    // --- Step 5. Clean the extracted title ---
    // Replace common separators (dots, underscores, hyphens) with a space
    titlePart = titlePart.replace(/[\._\-]+/g, " ");
    // Remove unwanted tokens such as quality/codec markers:
    const unwantedTokens = /\b(?:1080p|720p|WEBRip|BluRay|x264|x265|HDRip|DSNP|AMZN|NF|WEB[- ]?DL|DUAL|DDP5\.1|DDP|DD5\.1|5\.1|6CH|10bit|HEVC|HDR|SDR|AAC|AC3|ESub(?:s)?|MULTI)\b/gi;
    titlePart = titlePart.replace(unwantedTokens, "");
    // Normalize whitespace and trim extra spaces.
    titlePart = titlePart.replace(/\s+/g, " ").trim();

    // --- Step 6. Special handling: Remove leading "www" plus the next two words ---
    // Check if the first word (case-insensitive) is "www"
    let specialName;
    const words = titlePart.split(/\s+/);
    if (words.length && words[0].toLowerCase() === "www") {
        // Discard the first three words, if available
        if (words.length > 3) {
            specialName = words.slice(3).join(" ");
        } else {
            specialName = ""; // if fewer than 3 words exist, leave it empty.
        }
    }

    // --- Step 7. Build and return the result object ---
    const result = {
        parsed_name: titlePart,
        parsed_year: parsedYear
    };
    if (type) {
        result.type = type;
    }
    // Include the specialName property if defined
    if (specialName !== undefined) {
        result.specialName = specialName;
    }

    return result;
}

module.exports = {
    parseTitle
}