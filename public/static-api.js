/* Stillword with no server.
 *
 * GitHub Pages cannot run Flask, so the work the Python backend did happens in
 * the browser instead: the King James text and the dictionary ship as data
 * files beside the page, and passages come straight from bible-api.com, which
 * allows cross-origin reads. app.js calls these only when this file is present,
 * so the Flask app keeps working unchanged.
 */
(function () {
  "use strict";

  const KJV_URL = "data/kjv.json";
  const DICTIONARY_URL = "data/dictionary.json";
  const BIBLE_API = "https://bible-api.com";
  const SEARCH_LIMIT = 200;
  const REFERENCE_LIMIT = 6;
  const APPROX_RATIO = 0.5;
  const STOPWORDS = new Set(
    ("a an and are as at be been but by for from had has have he her him his i if in into is it " +
      "its me my no nor not of on or our she so than that the their them then there these they this " +
      "those to too us was we were what when where which who whom why will with you your").split(" ")
  );

  let indexPromise = null;
  let dictionaryPromise = null;
  let vocabulary = null;
  const nearCache = new Map();
  const passageCache = new Map();

  function loadIndex() {
    if (!indexPromise) {
      indexPromise = fetch(KJV_URL)
        .then(function (response) {
          if (!response.ok) throw new Error("Could not load the Bible text.");
          return response.json();
        })
        .then(function (payload) {
          const entries = [];
          payload.books.forEach(function (book) {
            book.chapters.forEach(function (verses, chapterIndex) {
              verses.forEach(function (text, verseIndex) {
                const chapter = chapterIndex + 1;
                const verse = verseIndex + 1;
                entries.push([
                  book.name + " " + chapter + ":" + verse,
                  book.name,
                  chapter,
                  verse,
                  text,
                  text.toLowerCase()
                ]);
              });
            });
          });
          return entries;
        })
        .catch(function (error) {
          indexPromise = null;
          throw error;
        });
    }
    return indexPromise;
  }

  function loadDictionary() {
    if (!dictionaryPromise) {
      dictionaryPromise = fetch(DICTIONARY_URL)
        .then(function (response) {
          if (!response.ok) throw new Error("Could not load the dictionary.");
          return response.json();
        })
        .then(function (payload) {
          return payload.terms;
        })
        .catch(function (error) {
          dictionaryPromise = null;
          throw error;
        });
    }
    return dictionaryPromise;
  }

  function tokens(text) {
    return String(text)
      .toLowerCase()
      .replace(/[^0-9a-z']+/g, " ")
      .split(" ")
      .map(function (word) {
        return word.replace(/^'+|'+$/g, "");
      })
      .filter(Boolean);
  }

  function queryWords(term) {
    const words = [];
    tokens(term).forEach(function (word) {
      if (word.length < 2 || STOPWORDS.has(word)) return;
      if (words.indexOf(word) === -1) words.push(word);
    });
    return words;
  }

  function withinDistance(a, b, limit) {
    if (Math.abs(a.length - b.length) > limit) return false;
    if (a === b) return true;
    let previous = [];
    for (let j = 0; j <= b.length; j += 1) previous.push(j);
    for (let i = 1; i <= a.length; i += 1) {
      const current = [i];
      let best = i;
      for (let j = 1; j <= b.length; j += 1) {
        const cost = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
        const value = Math.min(previous[j] + 1, current[j - 1] + 1, cost);
        current.push(value);
        if (value < best) best = value;
      }
      if (best > limit) return false;
      previous = current;
    }
    return previous[b.length] <= limit;
  }

  function buildVocabulary(entries) {
    if (vocabulary) return vocabulary;
    vocabulary = new Set();
    entries.forEach(function (entry) {
      tokens(entry[4]).forEach(function (word) {
        vocabulary.add(word);
      });
    });
    return vocabulary;
  }

  function nearWords(word, entries) {
    if (nearCache.has(word)) return nearCache.get(word);
    if (word.length < 5) {
      nearCache.set(word, [word]);
      return [word];
    }
    const limit = word.length < 8 ? 1 : 2;
    const found = [];
    buildVocabulary(entries).forEach(function (candidate) {
      if (candidate === word || Math.abs(candidate.length - word.length) > limit) return;
      if (withinDistance(word, candidate, limit)) {
        found.push([Math.abs(candidate.length - word.length), candidate]);
      }
    });
    found.sort(function (left, right) {
      if (left[0] !== right[0]) return left[0] - right[0];
      return left[1] < right[1] ? -1 : 1;
    });
    const result = [word].concat(found.slice(0, 3).map(function (pair) { return pair[1]; }));
    nearCache.set(word, result);
    return result;
  }

  function leadingWordsInCommon(query, verse) {
    const left = tokens(query);
    const right = tokens(verse);
    let shared = 0;
    while (shared < left.length && shared < right.length && left[shared] === right[shared]) {
      shared += 1;
    }
    return shared;
  }

  function approximate(entries, term, limit) {
    const words = queryWords(term);
    if (!words.length) return { total: 0, results: [], matchedWords: [] };

    const variants = new Map();
    words.forEach(function (word) {
      variants.set(word, nearWords(word, entries));
    });
    const needed = Math.max(1, Math.ceil(words.length * APPROX_RATIO));
    const candidates = [];
    const frequency = new Map();
    words.forEach(function (word) {
      frequency.set(word, 0);
    });

    entries.forEach(function (entry) {
      const lowered = entry[5];
      const matched = words.filter(function (word) {
        return variants.get(word).some(function (variant) {
          return lowered.indexOf(variant) !== -1;
        });
      });
      if (matched.length >= needed) {
        candidates.push([entry, matched]);
        matched.forEach(function (word) {
          frequency.set(word, frequency.get(word) + 1);
        });
      }
    });

    if (!candidates.length) return { total: 0, results: [], matchedWords: words };

    const totalVerses = entries.length;
    function score(entry, matched) {
      const rarity = matched.reduce(function (sum, word) {
        return sum + Math.log(1 + totalVerses / Math.max(frequency.get(word), 1));
      }, 0);
      return rarity + 50 * leadingWordsInCommon(term, entry[4]);
    }

    candidates.sort(function (left, right) {
      const difference = score(right[0], right[1]) - score(left[0], left[1]);
      if (difference !== 0) return difference;
      return left[0][4].length - right[0][4].length;
    });

    return {
      total: candidates.length,
      results: candidates.slice(0, limit).map(function (pair) {
        return {
          reference: pair[0][0],
          book: pair[0][1],
          chapter: pair[0][2],
          verse: pair[0][3],
          text: pair[0][4],
          matched: pair[1]
        };
      }),
      matchedWords: words
    };
  }

  async function search(term) {
    const needle = (term || "").trim();
    const entries = await loadIndex();
    const loweredNeedle = needle.toLowerCase();

    let total = 0;
    const results = [];
    entries.forEach(function (entry) {
      if (entry[5].indexOf(loweredNeedle) === -1) return;
      total += 1;
      if (results.length < SEARCH_LIMIT) {
        results.push({
          reference: entry[0],
          book: entry[1],
          chapter: entry[2],
          verse: entry[3],
          text: entry[4]
        });
      }
    });

    let isApproximate = false;
    let matchedWords = [];
    if (total === 0) {
      const closest = approximate(entries, needle, SEARCH_LIMIT);
      total = closest.total;
      results.length = 0;
      closest.results.forEach(function (result) {
        results.push(result);
      });
      isApproximate = true;
      matchedWords = closest.matchedWords;
    }

    return {
      query: needle,
      total: total,
      shown: results.length,
      results: results,
      approximate: isApproximate,
      matched_words: matchedWords
    };
  }

  async function define(term) {
    const needle = (term || "").trim();
    const terms = await loadDictionary();
    const key = needle.toLowerCase().replace(/\s+/g, " ");

    let entry = terms[key] || null;
    if (!entry && key.length >= 3) {
      const keys = Object.keys(terms);
      for (let i = 0; i < keys.length; i += 1) {
        if (keys[i].indexOf(key) === 0) { entry = terms[keys[i]]; break; }
      }
      if (!entry) {
        for (let i = 0; i < keys.length; i += 1) {
          if (keys[i].indexOf(key) !== -1) { entry = terms[keys[i]]; break; }
        }
      }
    }
    if (!entry) return { term: needle, found: false, meanings: [], total: 0, references: [] };

    const entries = await loadIndex();
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp("\\b" + escaped + "\\b");
    let total = 0;
    const references = [];
    entries.forEach(function (item) {
      if (!pattern.test(item[5])) return;
      total += 1;
      if (references.length < REFERENCE_LIMIT) {
        references.push({
          reference: item[0],
          book: item[1],
          chapter: item[2],
          verse: item[3],
          text: item[4]
        });
      }
    });

    return {
      term: needle,
      found: true,
      matched_term: entry.display,
      meanings: entry.meanings,
      total: total,
      references: references
    };
  }

  async function passage(reference, translation) {
    const key = translation + "|" + reference;
    if (passageCache.has(key)) return passageCache.get(key);

    const url =
      BIBLE_API + "/" + encodeURIComponent(reference) + "?" +
      new URLSearchParams({ translation: translation }).toString();
    const response = await fetch(url);
    let data = {};
    try {
      data = await response.json();
    } catch (error) {
      data = {};
    }
    if (!response.ok) {
      if (response.status === 429) {
        throw new Error("The Bible service is busy. Try again in a moment.");
      }
      throw new Error(data.error || "Could not load that passage.");
    }
    if (!data.verses || !data.verses.length) {
      throw new Error("That passage has no verses.");
    }
    passageCache.set(key, data);
    return data;
  }

  window.StaticApi = {
    passage: passage,
    search: search,
    define: define,
    preload: loadIndex
  };
})();
