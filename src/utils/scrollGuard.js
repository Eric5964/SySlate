// Tells sliders whether the page they sit on is scrolling right now, so a
// slider never grabs the finger while the screen is moving. The Settings
// scroll view reports every scroll position; "scrolling" means it moved at
// more than a few pixels per second a moment ago.
let lastY = 0;
let lastT = 0;
let speed = 0;
const SPEED_LIMIT = 12;   // px per second
const FRESH_MS = 180;     // no scroll report for this long = stopped

export function noteScroll(y) {
    const now = Date.now();
    if (lastT && now > lastT) speed = (Math.abs(y - lastY) / (now - lastT)) * 1000;
    lastY = y;
    lastT = now;
}
export function isScrolling() {
    return Date.now() - lastT < FRESH_MS && speed > SPEED_LIMIT;
}
