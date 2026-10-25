import React, { createContext, useContext } from 'react';

export const LibraryContext = createContext({
    playlists: [],
    allSongs: [],
    scanPath: '',
    scanError: null,
    reload: async () => { },
    reorderPlaylists: () => { },
    withBusy: async (title, fn) => fn(() => { }),
});

export const useLibrary = () => useContext(LibraryContext);