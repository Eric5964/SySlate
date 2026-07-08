import React, { createContext, useContext } from 'react';

export const LibraryContext = createContext({
    playlists: [],
    allSongs: [],
    scanPath: '',
    reload: async () => { },
});

export const useLibrary = () => useContext(LibraryContext);