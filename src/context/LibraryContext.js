import React, { createContext, useContext } from 'react';

export const LibraryContext = createContext({
    playlists: [],
    allSongs: [],
    scanPath: '',
    scanError: null,
    reload: async () => { },
    reorderPlaylists: () => { },
});

export const useLibrary = () => useContext(LibraryContext);