/* ════════════════════════════════════════════════════════════════
   NAADI AI — MOTIVATIONAL QUOTES (quotes.js)
   50 quotes, rotated on the Home screen:
     • a fresh quote on every login / app open
     • auto-advance every 30s (crossfade)
     • tap the card to advance manually

   Rotation uses a SHUFFLE BAG: quotes are drawn without replacement
   until the pool is exhausted, then reshuffled. This guarantees a
   student never sees the same quote twice in a row (and never twice
   in one 50-quote cycle). The bag persists in localStorage so the
   cycle survives an app restart.

   To edit the quotes: change QUOTES below and ship a new build.
   ════════════════════════════════════════════════════════════════ */

const NAADI_QUOTES = [
    { text: "The expert in anything was once a beginner.", author: "Helen Hayes" },
    { text: "It always seems impossible until it is done.", author: "Nelson Mandela" },
    { text: "Small daily improvements are the key to staggering long-term results.", author: "Anonymous" },
    { text: "You do not rise to the level of your goals. You fall to the level of your systems.", author: "James Clear" },
    { text: "The best way to predict your future is to create it.", author: "Abraham Lincoln" },
    { text: "Wherever the art of medicine is loved, there is also a love of humanity.", author: "Hippocrates" },
    { text: "Discipline is choosing between what you want now and what you want most.", author: "Abraham Lincoln" },
    { text: "Do not pray for an easy life. Pray for the strength to endure a difficult one.", author: "Bruce Lee" },
    { text: "The doctor of the future will give no medicine, but will interest patients in the care of the human frame.", author: "Thomas Edison" },
    { text: "Success is the sum of small efforts repeated day in and day out.", author: "Robert Collier" },
    { text: "A river cuts through rock not because of its power, but its persistence.", author: "James N. Watkins" },
    { text: "Study hard what interests you the most, in the most undisciplined and irreverent manner possible.", author: "Richard Feynman" },
    { text: "Learning is not attained by chance. It must be sought for with ardour and diligence.", author: "Abigail Adams" },
    { text: "Fall seven times, stand up eight.", author: "Japanese Proverb" },
    { text: "The only way to learn mathematics is to do mathematics.", author: "Paul Halmos" },
    { text: "You don't have to be great to start, but you have to start to be great.", author: "Zig Ziglar" },
    { text: "Every chapter you finish is a patient you will one day be able to help.", author: "NAADI" },
    { text: "Knowledge is of no value unless you put it into practice.", author: "Anton Chekhov" },
    { text: "Courage doesn't always roar. Sometimes it is the quiet voice saying, I will try again tomorrow.", author: "Mary Anne Radmacher" },
    { text: "The good physician treats the disease; the great physician treats the patient who has the disease.", author: "William Osler" },
    { text: "What we learn with pleasure we never forget.", author: "Alfred Mercier" },
    { text: "Perseverance is not a long race; it is many short races one after another.", author: "Walter Elliot" },
    { text: "The pain you feel today will be the strength you feel tomorrow.", author: "Anonymous" },
    { text: "Don't watch the clock; do what it does. Keep going.", author: "Sam Levenson" },
    { text: "Nothing in life is to be feared, it is only to be understood.", author: "Marie Curie" },
    { text: "There is no substitute for hard work.", author: "Thomas Edison" },
    { text: "Errors of judgement must occur in the practice of an art which consists largely of balancing probabilities.", author: "William Osler" },
    { text: "Continuous effort — not strength or intelligence — is the key to unlocking our potential.", author: "Winston Churchill" },
    { text: "You are always a student, never a master. You have to keep moving forward.", author: "Conrad Hall" },
    { text: "One day or day one. You decide.", author: "Anonymous" },
    { text: "A goal without a plan is just a wish.", author: "Antoine de Saint-Exupéry" },
    { text: "It is not the mountain we conquer, but ourselves.", author: "Edmund Hillary" },
    { text: "The scientist is not a person who gives the right answers, but one who asks the right questions.", author: "Claude Lévi-Strauss" },
    { text: "Repetition is the mother of learning, the father of action.", author: "Zig Ziglar" },
    { text: "Motivation gets you started. Habit keeps you going.", author: "Jim Rohn" },
    { text: "Somewhere, something incredible is waiting to be known.", author: "Carl Sagan" },
    { text: "Your only limit is the one you set yourself.", author: "Anonymous" },
    { text: "The whole art of medicine is in observation.", author: "William Osler" },
    { text: "Patience, persistence and perspiration make an unbeatable combination for success.", author: "Napoleon Hill" },
    { text: "Do the hard things first. The rest of the day is a gift.", author: "NAADI" },
    { text: "Mistakes are proof that you are trying.", author: "Anonymous" },
    { text: "Concentrate all your thoughts upon the work in hand.", author: "Alexander Graham Bell" },
    { text: "Live as if you were to die tomorrow. Learn as if you were to live forever.", author: "Mahatma Gandhi" },
    { text: "You will never always be motivated. You must learn to be disciplined.", author: "Anonymous" },
    { text: "Great things are done by a series of small things brought together.", author: "Vincent van Gogh" },
    { text: "The difference between ordinary and extraordinary is that little extra.", author: "Jimmy Johnson" },
    { text: "Believe you can and you're halfway there.", author: "Theodore Roosevelt" },
    { text: "An investment in knowledge pays the best interest.", author: "Benjamin Franklin" },
    { text: "The seed of your white coat is planted in the hours nobody sees you study.", author: "NAADI" },
    { text: "Slow progress is still progress. Zero progress is the only failure.", author: "NAADI" },
];

// ── Shuffle bag ─────────────────────────────────────────────────
const QUOTE_BAG_KEY = 'NAADI_QUOTE_BAG';

function _shuffledIndices() {
    const arr = NAADI_QUOTES.map((_, i) => i);
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function _readBag() {
    try {
        const raw = localStorage.getItem(QUOTE_BAG_KEY);
        const bag = raw ? JSON.parse(raw) : null;
        if (Array.isArray(bag) && bag.length) return bag;
    } catch (_) { /* corrupt bag → reshuffle */ }
    return null;
}

function _writeBag(bag) {
    try { localStorage.setItem(QUOTE_BAG_KEY, JSON.stringify(bag)); } catch (_) { }
}

/**
 * Draw the next quote without replacement. Reshuffles automatically
 * once the 50-quote pool is exhausted.
 * @returns {{text:string, author:string}}
 */
function nextQuote() {
    let bag = _readBag();
    if (!bag) bag = _shuffledIndices();
    const idx = bag.pop();
    _writeBag(bag.length ? bag : _shuffledIndices());
    return NAADI_QUOTES[idx] || NAADI_QUOTES[0];
}