import React, { createContext, useContext } from 'react';

export const LibraryContext = createContext({
    playlists: [],
    allSongs: [],
    reload: async () => { },
});

export const useLibrary = () => useContext(LibraryContext);