// Performance mode flag for code that is not a React component (the session
// saver, the debug log). Components read `performanceMode` from
// usePreferences() instead; PreferencesContext keeps this in step.
export const perf = { on: false };
export const setPerf = (v) => { perf.on = !!v; };
