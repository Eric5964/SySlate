import React, { useContext, useState, useEffect, useLayoutEffect, useCallback, useMemo, memo, useRef, createContext } from 'react';
import {
    View, Text, FlatList, TouchableOpacity, Pressable, StyleSheet, StatusBar, Image, Alert, Dimensions, Animated, PanResponder, Easing,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { LibraryContext } from '../context/LibraryContext';
import { useTheme } from '../context/ThemeContext';
import { usePreferences } from '../context/PreferencesContext';
import { squircle } from '../utils/squircle';
import {
    getPlaylistViewFormat, setPlaylistViewFormat,
    setPlaylistOrder,
    getPlaylistCovers, setPlaylistCover, persistCoverImage, shrinkOldPlaylistCovers,
} from '../utils/storage';
import BottomSheet from '../components/BottomSheet';
import ScreenBackground from '../components/ScreenBackground';

const SCREEN_W = Dimensions.get('window').width;
const GRID_PADDING = 8;
const CELL_MARGIN = 5;

// Fixed pixel math instead of percentage/aspectRatio-based sizing — that
// combination was behaving unpredictably (only ever showing part of a grid),
// so every sized element in this screen now computes its exact pixel size
// up front from the screen width.
function cellSize(cols) {
    const usable = SCREEN_W - GRID_PADDING * 2 - CELL_MARGIN * 2 * cols;
    return Math.floor(usable / cols);
}
const CELL_SIZES = { 2: cellSize(2), 3: cellSize(3) };

// The 3-column layout's button: a 3 by 3 grid of dots, drawn instead of typed,
// so it looks like the layout and stays the same height as the other icons.
function DotsGridIcon({ color }) {
    const dot = { width: 4, height: 4, borderRadius: 1, backgroundColor: color };
    return (
        <View style={{ width: 18, height: 18, justifyContent: 'space-between' }}>
            {[0, 1, 2].map(r => (
                <View key={r} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    {[0, 1, 2].map(c => <View key={c} style={dot} />)}
                </View>
            ))}
        </View>
    );
}

const FORMATS = [
    { id: 'list', label: '☰', cols: 1 },
    { id: 'list_art', label: '⊟', cols: 1 },
    { id: 'grid2', label: '⊞', cols: 2 },
    { id: 'grid3', label: '⋮⋮', cols: 3 },
];

// Reordering needs each playlist's position on screen. The FlatList's own
// row wrapper reports where each row sits (grids put several playlists in
// one row), and each playlist reports where it sits inside its row.
const DragCtx = createContext({ rowLayouts: { current: {} }, dragRow: -1 });
function RowCell({ index, onLayout, style, children, ...rest }) {
    const { rowLayouts, dragRow } = useContext(DragCtx);
    return (
        <View
            {...rest}
            style={[style, dragRow === index && { zIndex: 50 }]}
            onLayout={(e) => { rowLayouts.current[index] = e.nativeEvent.layout; if (onLayout) onLayout(e); }}
        >
            {children}
        </View>
    );
}

// Memoized so the hold/drag state living in the parent doesn't re-render
// every visible row, only the one being held.
const PlaylistRow = memo(function PlaylistRow({ item, index, format, numCols, cover, base, coverShape, showTitle, showCount, isActive, isDragging, editing, anim, lift, onItemLayout, onPressIn, onPressOut, onPress }) {
    // Edit mode: every playlist wiggles, like the iOS home screen (each one a
    // little out of step with the others). The one being held stays still.
    const jig = useRef(new Animated.Value(0)).current;
    const jiggling = !!editing && !isActive;
    useEffect(() => {
        if (!jiggling) {
            jig.stopAnimation();
            Animated.timing(jig, { toValue: 0, duration: 90, useNativeDriver: true }).start();
            return undefined;
        }
        const leg = 105 + (index % 4) * 9;
        jig.setValue(index % 2 ? -1 : 1);
        const loop = Animated.loop(Animated.sequence([
            Animated.timing(jig, { toValue: index % 2 ? 1 : -1, duration: leg, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
            Animated.timing(jig, { toValue: index % 2 ? -1 : 1, duration: leg, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        ]));
        loop.start();
        return () => loop.stop();
    }, [jiggling, index, jig]);
    const amp = format.startsWith('grid') ? (numCols === 3 ? 2.4 : 1.8) : 0.5;
    const jigDeg = jig.interpolate({ inputRange: [-1, 1], outputRange: [`-${amp}deg`, `${amp}deg`] });
    // Neutral placeholder instead of playlistColor()'s bright per-name
    // palette — requested: the colorful boxes shown while covers load were
    // distracting. Same surface tone the rest of the UI already uses.
    const bg = base.surface;

    const renderArt = (size, fontSize) => cover
        ? <Image source={{ uri: cover }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
        : <Text style={{ fontSize, color: 'rgba(255,255,255,0.4)' }}>♪</Text>;

    const wrapStyle = [
        { transform: [...anim.getTranslateTransform(), { scale: isActive ? lift : 1 }, { rotate: jigDeg }] },
        isDragging && isActive && s.lifted,
    ];
    const handlers = {
        onPressIn: () => onPressIn(item, index),
        onPressOut: () => onPressOut(item, index),
        onPress: () => onPress(item, index),
    };

    if (format.startsWith('grid')) {
        const size = CELL_SIZES[numCols];
        return (
            <Animated.View style={wrapStyle} onLayout={(e) => onItemLayout(index, e.nativeEvent.layout)}>
                <Pressable
                    style={({ pressed }) => [s.gridItem, { width: size, margin: CELL_MARGIN, opacity: pressed && !isActive ? 0.75 : 1 }]}
                    {...handlers}
                >
                    <View style={[s.gridArt, { width: size, height: size, backgroundColor: bg, borderRadius: squircle(size, coverShape) }]}>
                        {renderArt(numCols === 3 ? 28 : 40, numCols === 3 ? 28 : 40)}
                    </View>
                    {showTitle !== false && <Text style={[s.gridName, { color: base.text }]} numberOfLines={2}>{item.name}</Text>}
                    {showCount !== false && <Text style={[s.gridCount, { color: base.textFaint }]}>{item.songs.length} tracks</Text>}
                </Pressable>
            </Animated.View>
        );
    }
    return (
        <Animated.View style={wrapStyle} onLayout={(e) => onItemLayout(index, e.nativeEvent.layout)}>
            <Pressable style={({ pressed }) => [s.row, { backgroundColor: base.surface, opacity: pressed && !isActive ? 0.75 : 1 }]} {...handlers}>
                {format === 'list_art' && (
                    <View style={[s.listArt, { backgroundColor: bg, overflow: 'hidden', borderRadius: squircle(50, coverShape) }]}>
                        {renderArt(22, 22)}
                    </View>
                )}
                <View style={{ flex: 1 }}>
                    {showTitle !== false && <Text style={[s.rowName, { color: base.text }]}>{item.name}</Text>}
                    {showCount !== false && <Text style={[s.rowCount, { color: base.textFaint }]}>{item.songs.length} tracks</Text>}
                </View>
                <Text style={[s.arrow, { color: base.textFaint }]}>›</Text>
            </Pressable>
        </Animated.View>
    );
});

const LIFT_MS = 500;        // iOS touch-and-hold: the playlist lifts. Let go = menu, move = drag
const EDIT_LIFT_MS = 120;   // in edit mode a playlist can be grabbed almost at once
const EMPTY_HOLD_MS = 600;  // hold empty space to enter edit mode
const DRAG_SLOP = 6;        // points the finger must move after the lift to start a drag
const EDGE = 90;            // auto-scroll zone at the top and bottom of the list
const MAX_SCROLL = 14;      // px per frame at the very edge

export default function PlaylistsScreen() {
    const { playlists, covers: initialCovers, reload, reorderPlaylists } = useContext(LibraryContext);
    const { theme, base } = useTheme();
    const { coverShape, showPlaylistTrackCount, showPlaylistTitles } = usePreferences();
    const navigation = useNavigation();
    const [format, setFormat] = useState('list');
    // Real gap found here: this always started at {} and waited on its own
    // fresh getPlaylistCovers() fetch (below) to populate it — even on a
    // cold launch where App.js's prefetchPlaylistCovers() had already
    // resolved the exact same data (and warmed the actual image bytes)
    // moments earlier. Seeding from that already-known map means a cold
    // launch's first paint can show real covers immediately instead of
    // colored placeholders for a beat; the effects below still keep this
    // fresh afterward (a playlist-covers change elsewhere, or refocusing
    // this screen) exactly as before.
    const [covers, setCovers] = useState(initialCovers || {});
    const [menuFor, setMenuFor] = useState(null);
    const [displayedMenuFor, setDisplayedMenuFor] = useState(null);
    useEffect(() => { if (menuFor) setDisplayedMenuFor(menuFor); }, [menuFor]);

    useEffect(() => { getPlaylistViewFormat().then(f => f && setFormat(f)); }, []);
    useEffect(() => { getPlaylistCovers().then(setCovers); }, [playlists]);
    // Shrinks any older full-size covers once per launch, then refreshes.
    useEffect(() => {
        const t = setTimeout(() => {
            shrinkOldPlaylistCovers().then(changed => { if (changed) getPlaylistCovers().then(setCovers); });
        }, 3000);
        return () => clearTimeout(t);
    }, []);
    useFocusEffect(useCallback(() => {
        getPlaylistCovers().then(setCovers);
        // Picks up a layout change made elsewhere (Reset Playlist Screen in Settings).
        getPlaylistViewFormat().then(f => {
            if (!f) return;
            setFormat(prev => {
                if (prev === f) return prev;
                itemLayouts.current = []; rowLayouts.current = {};
                return f;
            });
        });
        return () => { editRef.current = false; setEditMode(false); };
    }, []));

    const listOpacity = useRef(new Animated.Value(1)).current;

    const cycleFormat = async () => {
        const idx = FORMATS.findIndex(f => f.id === format);
        const next = FORMATS[(idx + 1) % FORMATS.length];
        Animated.timing(listOpacity, { toValue: 0, duration: 90, useNativeDriver: true }).start(() => {
            itemLayouts.current = []; rowLayouts.current = {};
            setFormat(next.id);
            setPlaylistViewFormat(next.id);
            requestAnimationFrame(() => {
                Animated.timing(listOpacity, { toValue: 1, duration: 180, useNativeDriver: true }).start();
            });
        });
    };

    const isGrid = format.startsWith('grid');
    const numCols = FORMATS.find(f => f.id === format)?.cols ?? 1;
    const fmtIcon = FORMATS.find(f => f.id === format)?.label ?? '☰';

    // Pass the cover URI we already have in memory (from this screen's own
    // grid thumbnails) straight through as a nav param — see
    // PlaylistDetailScreen's own comment on why it used the initial state
    // for this instead of always starting from null and refetching. This
    // is exactly the "playlist cover has to load every time, should be
    // cached" report: the target screen's own Image.prefetch-before-render
    // fix already stopped the BLANK-FRAME flash, but every single open
    // still paid for a fresh AsyncStorage read + prefetch round trip before
    // the real cover could show at all — invisible on a fast connection to
    // fast storage, not so invisible on this setup. When we already know
    // the answer, hand it over directly instead of making the next screen
    // rediscover it from scratch.
    const openPlaylist = (item) => navigation.navigate('PlaylistDetail', { playlist: item, initialCover: covers[item.path] ?? null });
    const openPlaylistRef = useRef(openPlaylist);
    openPlaylistRef.current = openPlaylist;

    // ---- Hold and reorder (like iOS) -----------------------------------
    // Hold briefly and let go: menu (change / remove cover). Keep holding:
    // the playlist is picked up, drag it to a new spot and let go.
    const [editMode, setEditMode] = useState(false);
    const editRef = useRef(false);
    const pressingRef = useRef(false);
    const emptyHold = useRef({ timer: null, x: 0, y: 0 });
    const enterEdit = useCallback(() => { editRef.current = true; setEditMode(true); }, []);
    const exitEdit = useCallback(() => { editRef.current = false; setEditMode(false); }, []);
    const [activeIndex, setActiveIndex] = useState(-1);
    const [dragging, setDragging] = useState(false);
    const lift = useRef(new Animated.Value(1)).current;
    const animsRef = useRef({});
    const getAnim = (path) => (animsRef.current[path] || (animsRef.current[path] = new Animated.ValueXY()));
    const itemLayouts = useRef([]);
    const rowLayouts = useRef({});
    const listRef = useRef(null);
    const listBoxRef = useRef(null);
    const scrollY = useRef(0);
    const viewH = useRef(0);
    const contentH = useRef(0);
    const timers = useRef({ lift: null, pick: null, scroll: null, reset: null });
    const flags = useRef({ lifted: false, picked: false, captured: false, dropping: false });
    const drag = useRef({ active: false, from: -1, target: -1, slots: [], scroll0: 0, listTop: 0, fingerVY: 0, dx: 0, dy: 0, preDx: 0, preDy: 0 });
    const playlistsRef = useRef(playlists);
    playlistsRef.current = playlists;
    const numColsRef = useRef(numCols);
    numColsRef.current = numCols;

    const ctxValue = useMemo(() => ({ rowLayouts, dragRow: activeIndex < 0 ? -1 : Math.floor(activeIndex / numCols) }), [activeIndex, numCols]);

    const onItemLayout = useCallback((index, layout) => { itemLayouts.current[index] = layout; }, []);

    const getSlots = () => {
        const n = playlistsRef.current.length;
        const cols = numColsRef.current;
        const out = [];
        for (let i = 0; i < n; i++) {
            const it = itemLayouts.current[i];
            const row = rowLayouts.current[Math.floor(i / cols)];
            if (!it || !row) return null;
            out.push({ cx: row.x + it.x + it.width / 2, cy: row.y + it.y + it.height / 2 });
        }
        return out;
    };

    const clearTimers = () => {
        clearTimeout(timers.current.lift); clearTimeout(timers.current.pick);
        timers.current.lift = null; timers.current.pick = null;
    };
    const stopAutoScroll = () => { clearInterval(timers.current.scroll); timers.current.scroll = null; };

    // Puts a playlist back to normal (not lifted, not armed for dragging).
    const resetHold = () => {
        const d = drag.current;
        d.active = false;
        stopAutoScroll();
        flags.current = { lifted: false, picked: false, captured: false, dropping: flags.current.dropping };
        setDragging(false);
        setActiveIndex(-1);
        Animated.timing(lift, { toValue: 1, duration: 160, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    };

    const updateTarget = () => {
        const d = drag.current;
        const c0 = d.slots[d.from];
        const px = c0.cx + d.dx;
        const py = c0.cy + d.dy + (scrollY.current - d.scroll0);
        let best = d.target, bestDist = Infinity;
        for (let j = 0; j < d.slots.length; j++) {
            const dist = (d.slots[j].cx - px) ** 2 + (d.slots[j].cy - py) ** 2;
            if (dist < bestDist) { bestDist = dist; best = j; }
        }
        if (best === d.target) return;
        d.target = best;
        const list = playlistsRef.current;
        for (let i = 0; i < list.length; i++) {
            if (i === d.from) continue;
            let slot = i;
            if (d.from < best && i > d.from && i <= best) slot = i - 1;
            else if (d.from > best && i >= best && i < d.from) slot = i + 1;
            Animated.timing(getAnim(list[i].path), {
                toValue: { x: d.slots[slot].cx - d.slots[i].cx, y: d.slots[slot].cy - d.slots[i].cy },
                duration: 240, easing: Easing.out(Easing.cubic), useNativeDriver: true,
            }).start();
        }
    };

    const applyDrag = () => {
        const d = drag.current;
        if (!d.active) return;
        getAnim(playlistsRef.current[d.from].path).setValue({ x: d.dx, y: d.dy + (scrollY.current - d.scroll0) });
        updateTarget();
    };

    // Called once the hold is long enough (like iOS: the item lifts). From
    // here a finger movement starts a drag; letting go in place opens the menu.
    const liftUp = (index) => {
        flags.current.lifted = true;
        setActiveIndex(index);
        Animated.spring(lift, { toValue: 1.05, friction: 8, tension: 170, useNativeDriver: true }).start();
        const slots = getSlots();
        if (!slots || slots.length < 2) return;   // nothing to reorder: stays a menu hold
        const d = drag.current;
        d.active = true; d.from = index; d.target = index; d.slots = slots;
        d.scroll0 = scrollY.current; d.dx = 0; d.dy = 0; d.preDx = 0; d.preDy = 0; d.fingerVY = -1;
        if (listBoxRef.current) listBoxRef.current.measureInWindow((x, y) => { d.listTop = y; });
        setDragging(true);   // the list stops scrolling under the held finger
        stopAutoScroll();
        timers.current.scroll = setInterval(() => {
            if (!drag.current.active || !flags.current.picked || drag.current.fingerVY < 0) return;
            const fy = drag.current.fingerVY;
            let v = 0;
            if (fy < EDGE) v = -((EDGE - fy) / EDGE) * MAX_SCROLL;
            else if (fy > viewH.current - EDGE) v = ((fy - (viewH.current - EDGE)) / EDGE) * MAX_SCROLL;
            if (!v) return;
            const maxY = Math.max(0, contentH.current - viewH.current);
            const ny = Math.max(0, Math.min(maxY, scrollY.current + v));
            if (ny === scrollY.current) return;
            scrollY.current = ny;
            if (listRef.current) listRef.current.scrollToOffset({ offset: ny, animated: false });
            applyDrag();
        }, 16);
    };

    const endDrag = () => {
        const d = drag.current;
        if (!d.active) return;
        d.active = false;
        stopAutoScroll();
        flags.current.dropping = true;
        const list = playlistsRef.current;
        const from = d.from, target = d.target;
        const moved = target !== from;
        const dragged = getAnim(list[from].path);
        const toValue = moved
            ? { x: d.slots[target].cx - d.slots[from].cx, y: d.slots[target].cy - d.slots[from].cy }
            : { x: 0, y: 0 };
        Animated.parallel([
            Animated.timing(dragged, { toValue, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
            Animated.timing(lift, { toValue: 1, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        ]).start(() => {
            if (moved) {
                const next = [...list];
                const [it] = next.splice(from, 1);
                next.splice(target, 0, it);
                persistOrder(next);
            }
            flags.current = { lifted: false, picked: false, captured: false, dropping: false };
            setDragging(false);
            setActiveIndex(-1);
            if (!moved) Object.values(animsRef.current).forEach(a => a.setValue({ x: 0, y: 0 }));
        });
    };

    // The new order is on screen: now every playlist can drop its temporary
    // offset (they already sit in their new slots, so nothing visibly moves).
    const orderKey = playlists.map(p => p.path).join('|');
    useLayoutEffect(() => {
        Object.values(animsRef.current).forEach(a => a.setValue({ x: 0, y: 0 }));
    }, [orderKey]);

    // The press/drag handlers below are created once, so they reach the
    // current versions of these functions through this ref.
    const latest = useRef({});
    const pressIn = useCallback((item, index) => {
        clearTimers();
        clearTimeout(timers.current.reset);
        if (drag.current.active || flags.current.dropping) return;
        flags.current = { lifted: false, picked: false, captured: false, dropping: false };
        pressingRef.current = true;
        // iOS: a touch-and-hold of about half a second lifts the item (in edit
        // mode it takes a tenth of a second).
        timers.current.lift = setTimeout(() => latest.current.liftUp(index), editRef.current ? EDIT_LIFT_MS : LIFT_MS);
    }, []);

    const pressOut = useCallback(() => {
        pressingRef.current = false;
        clearTimers();
        if (flags.current.captured) return;   // being dragged: the drag handler finishes it
        // A real release runs onPress right after this in the same tick (it
        // reads the flags first). A cancelled touch (a scroll took over)
        // never gets onPress, so this puts the row back to normal.
        clearTimeout(timers.current.reset);
        timers.current.reset = setTimeout(() => { if (!flags.current.captured && !flags.current.dropping) latest.current.resetHold(); }, 0);
    }, []);

    const pressRelease = useCallback((item) => {
        if (flags.current.dropping) return;
        if (flags.current.captured) { latest.current.endDrag(); return; }
        if (flags.current.lifted) {
            // Held, then let go without dragging: the menu (not in edit mode).
            clearTimeout(timers.current.reset);
            latest.current.resetHold();
            setMenuFor(item);   // also in edit mode: tap or short hold opens the cover menu
            return;
        }
        if (editRef.current) { setMenuFor(item); return; }   // edit mode: a tap opens the cover menu
        openPlaylistRef.current(item);
    }, []);

    const pan = useRef(PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        // Only after the item has lifted: moving the finger more than a few
        // points takes over from the list and starts the drag.
        onMoveShouldSetPanResponderCapture: (e, g) => {
            const d = drag.current;
            if (!d.active) return false;
            if (flags.current.captured) return true;
            if (Math.hypot(g.dx, g.dy) > DRAG_SLOP) {
                flags.current.captured = true;
                d.preDx = g.dx; d.preDy = g.dy;
                return true;
            }
            return false;
        },
        onPanResponderGrant: () => {
            flags.current.picked = true;
            // Dragging a playlist is what puts the screen into edit mode.
            if (!editRef.current) { editRef.current = true; setEditMode(true); }
            Animated.spring(lift, { toValue: 1.08, friction: 7, tension: 170, useNativeDriver: true }).start();
        },
        onPanResponderTerminationRequest: () => false,
        onPanResponderMove: (e, g) => {
            const d = drag.current;
            d.dx = d.preDx + g.dx; d.dy = d.preDy + g.dy; d.fingerVY = g.moveY - d.listTop;
            latest.current.applyDrag();
        },
        onPanResponderRelease: () => latest.current.endDrag(),
        onPanResponderTerminate: () => latest.current.endDrag(),
    })).current;

    useEffect(() => () => { clearTimers(); stopAutoScroll(); clearTimeout(timers.current.reset); }, []);

    const persistOrder = async (newList) => {
        // Reordering only needs to persist the small order list and update
        // what's on screen — it doesn't change anything about the songs or
        // playlists themselves. This used to call the same full reload()
        // used after a real library change, which re-scans the whole music
        // folder from disk AND re-prefetches every playlist's cover image,
        // just to reflect a reorder. That's what made "Move Up/Down/Top/
        // Bottom" feel slow to respond.
        setPlaylistOrder(newList.map(p => p.path));
        reorderPlaylists(newList);
    };
    latest.current = { liftUp, endDrag, resetHold, applyDrag };

    const moveItem = async (item, action) => {
        const list = [...playlists];
        const idx = list.findIndex(p => p.path === item.path);
        if (idx === -1) return;
        list.splice(idx, 1);
        let target;
        if (action === 'top') target = 0;
        else if (action === 'bottom') target = list.length;
        else if (action === 'up') target = Math.max(0, idx - 1);
        else if (action === 'down') target = Math.min(list.length, idx + 1);
        list.splice(target, 0, item);
        setMenuFor(null);
        await persistOrder(list);
    };

    const changeCover = async (item) => {
        setMenuFor(null);
        await new Promise(r => setTimeout(r, 320));
        const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!perm.granted) {
            Alert.alert('Permission needed', 'Allow Photos access in Settings to set a playlist cover.');
            return;
        }
        const result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.Images,
            allowsEditing: true,
            aspect: [1, 1],
            // Same as PlaylistDetailScreen's own cover picker — see its
            // comment.
            quality: 0.4,
        });
        if (result.canceled || !result.assets?.[0]?.uri) return;
        const permanentUri = await persistCoverImage(result.assets[0].uri, 600);
        // Real gap found here: App.js's reload() prefetches every playlist
        // cover, but only the ones already saved at COLD START — a cover
        // set or changed mid-session (right here) never went through
        // Image.prefetch at all, so its first paint (this row re-rendering
        // with the new uri right below) always decoded fresh from disk.
        // That's "sometimes the playlist covers [aren't cached]" — it was
        // never about the covers that existed at launch, only ones changed
        // during the session. Same wait-before-render reasoning as reload()
        // itself: awaiting this (not fire-and-forget) means the image is
        // actually in cache by the time setCovers below triggers the render.
        await Image.prefetch(permanentUri).catch(() => { });
        const next = await setPlaylistCover(item.path, permanentUri);
        setCovers(next);
    };

    const removeCover = async (item) => {
        setMenuFor(null);
        const next = await setPlaylistCover(item.path, null);
        setCovers(next);
    };

    return (
        <ScreenBackground style={s.container}>
            <StatusBar barStyle="light-content" />
            {/* Same top row as All Songs and the Player: title where the back
                arrow sits, buttons in the exact same top-right spots as EQ
                and queue (same sizes, same gap, same top padding). */}
            <View style={s.header}>
                <Text style={[s.title, { color: base.text, flex: 1, marginLeft: 16 }]}>Playlists</Text>
                {editMode ? (
                    <TouchableOpacity onPress={exitEdit} style={s.doneBtn} hitSlop={HIT}>
                        <Text style={[s.doneText, { color: theme.accent }]}>Done</Text>
                    </TouchableOpacity>
                ) : (
                    <View style={{ flexDirection: 'row', gap: 6 }}>
                        <TouchableOpacity onPress={cycleFormat} style={s.btn} hitSlop={HIT}>
                            {format === 'grid3'
                                ? <DotsGridIcon color={theme.accent} />
                                : <Text style={[s.btnText, { color: theme.accent }]}>{fmtIcon}</Text>}
                        </TouchableOpacity>
                        <TouchableOpacity onPress={reload} style={s.btn} hitSlop={HIT}>
                            <Text style={[s.btnText, { color: theme.accent }]}>↻</Text>
                        </TouchableOpacity>
                    </View>
                )}
            </View>
            {playlists.length === 0 ? (
                <View style={s.empty}>
                    <Text style={[s.emptyTitle, { color: base.text }]}>No playlists yet</Text>
                    <Text style={[s.emptyText, { color: base.textFaint }]}>Add folders to{'\n'}Files → On My iPhone → SySlate</Text>
                </View>
            ) : (
                <Animated.View style={{ flex: 1, opacity: listOpacity }}>
                    <View
                        ref={listBoxRef}
                        style={{ flex: 1 }}
                        onLayout={(e) => { viewH.current = e.nativeEvent.layout.height; }}
                        onTouchStart={(e) => {
                            const eh = emptyHold.current;
                            clearTimeout(eh.timer);
                            if (editRef.current || e.nativeEvent.touches.length > 1) return;
                            eh.x = e.nativeEvent.pageX; eh.y = e.nativeEvent.pageY;
                            // A touch on a playlist is handled by the playlist itself; this
                            // only fires when the finger is on empty space.
                            eh.timer = setTimeout(() => {
                                if (!pressingRef.current && !drag.current.active && !flags.current.lifted) enterEdit();
                            }, EMPTY_HOLD_MS);
                        }}
                        onTouchMove={(e) => {
                            const eh = emptyHold.current;
                            if (eh.timer && Math.hypot(e.nativeEvent.pageX - eh.x, e.nativeEvent.pageY - eh.y) > 10) { clearTimeout(eh.timer); eh.timer = null; }
                        }}
                        onTouchEnd={() => { clearTimeout(emptyHold.current.timer); }}
                        onTouchCancel={() => { clearTimeout(emptyHold.current.timer); }}
                        {...pan.panHandlers}
                    >
                    <DragCtx.Provider value={ctxValue}>
                    <FlatList
                        ref={listRef}
                        key={numCols}
                        data={playlists}
                        keyExtractor={item => item.path}
                        numColumns={numCols}
                        CellRendererComponent={RowCell}
                        // Every playlist stays mounted so each one has a
                        // measured spot to be dragged to.
                        initialNumToRender={Math.max(12, playlists.length)}
                        scrollEnabled={!dragging}
                        scrollEventThrottle={16}
                        onScroll={(e) => { scrollY.current = e.nativeEvent.contentOffset.y; }}
                        onContentSizeChange={(w, h) => { contentH.current = h; }}
                        // Grid rows already get top spacing from each cell's own
                        // CELL_MARGIN (applied on every side, top included) —
                        // the extra paddingTop this used to add on top of that
                        // was double-spacing, showing up as a noticeably
                        // fatter gap above the grid than above the list rows
                        // (which only rely on their own marginVertical).
                        contentContainerStyle={{ paddingBottom: 150, paddingHorizontal: isGrid ? GRID_PADDING : 0 }}
                        renderItem={({ item, index }) => (
                            <PlaylistRow
                                item={item}
                                index={index}
                                format={format}
                                numCols={numCols}
                                cover={covers[item.path]}
                                base={base}
                                coverShape={coverShape}
                                showTitle={showPlaylistTitles}
                                showCount={showPlaylistTrackCount}
                                isActive={index === activeIndex}
                                isDragging={dragging}
                                editing={editMode}
                                anim={getAnim(item.path)}
                                lift={lift}
                                onItemLayout={onItemLayout}
                                onPressIn={pressIn}
                                onPressOut={pressOut}
                                onPress={pressRelease}
                            />
                        )}
                    />
                    </DragCtx.Provider>
                    </View>
                </Animated.View>
            )}

            <BottomSheet visible={!!menuFor} onClose={() => setMenuFor(null)}>
                {displayedMenuFor && (
                    <>
                        <Text style={[s.menuTitle, { color: base.textFaint }]} numberOfLines={1}>{displayedMenuFor.name}</Text>
                        <MenuRow label="Change Cover Image" onPress={() => changeCover(displayedMenuFor)} />
                        {covers[displayedMenuFor.path] && <MenuRow label="Remove Cover Image" onPress={() => removeCover(displayedMenuFor)} />}
                        <MenuRow label="Move to Top" onPress={() => moveItem(displayedMenuFor, 'top')} />
                        <MenuRow label="Move Up" onPress={() => moveItem(displayedMenuFor, 'up')} />
                        <MenuRow label="Move Down" onPress={() => moveItem(displayedMenuFor, 'down')} />
                        <MenuRow label="Move to Bottom" onPress={() => moveItem(displayedMenuFor, 'bottom')} />
                        <MenuRow label="Cancel" onPress={() => setMenuFor(null)} muted />
                    </>
                )}
            </BottomSheet>
        </ScreenBackground>
    );
}

function MenuRow({ label, onPress, muted }) {
    const { base } = useTheme();
    return (
        <TouchableOpacity style={s.menuRow} onPress={onPress}>
            <Text style={[s.menuRowText, { color: base.text }, muted && { color: base.textFaint }]}>{label}</Text>
        </TouchableOpacity>
    );
}

const HIT = { top: 14, bottom: 14, left: 14, right: 14 };

const s = StyleSheet.create({
    container: { flex: 1 },
    lifted: { shadowColor: '#000', shadowOpacity: 0.55, shadowRadius: 14, shadowOffset: { width: 0, height: 8 }, elevation: 12 },
    // Round 39 trimmed this to 44 to fix "excess fat above the covers" —
    // wrong lever. That gap was actually gridItem's own padding/background
    // (see below, fixed this round), not header height. 44 just made this
    // screen's title sit noticeably higher than All Songs/Settings (both
    // paddingTop:60) and Playlist Detail (56) — restored to match.
    header: { flexDirection: 'row', alignItems: 'center', paddingTop: 56, paddingHorizontal: 8, paddingBottom: 8 },
    title: { color: '#e5e5e5', fontSize: 28, fontWeight: '700' },
    btn: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
    btnText: { fontSize: 20 },
    doneBtn: { height: 40, paddingHorizontal: 12, justifyContent: 'center', alignItems: 'center' },
    doneText: { fontSize: 17, fontWeight: '700' },
    empty: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 40 },
    emptyTitle: { color: '#e5e5e5', fontSize: 18, fontWeight: '600', marginBottom: 12 },
    emptyText: { color: '#555', fontSize: 14, textAlign: 'center', lineHeight: 22 },
    row: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 14, marginVertical: 3, paddingVertical: 16, paddingHorizontal: 16, backgroundColor: '#0f0f0f', borderRadius: 14, minHeight: 68 },
    listArt: { width: 50, height: 50, marginRight: 14, justifyContent: 'center', alignItems: 'center' },
    rowName: { color: '#e5e5e5', fontSize: 16, fontWeight: '500' },
    rowCount: { color: '#555', fontSize: 12, marginTop: 3 },
    arrow: { color: '#333', fontSize: 22 },
    // Real cause of the "extra base color stuff above each cover" (his
    // yellow-circled screenshot): this had its own padding:8 + a solid
    // #0f0f0f card background wrapping the art, while gridArt inside it was
    // ALSO set to the full cell `size` — so the art box was actually wider
    // than the padded space it sat in, overflowing the card and reading as
    // a visible dark band peeking out around/above the actual cover image.
    // No padding/background here now — the cell is just a layout box, the
    // cover image is the only visible surface.
    gridItem: { borderRadius: 14, alignItems: 'center' },
    gridArt: { justifyContent: 'center', alignItems: 'center', marginBottom: 8, overflow: 'hidden' },
    gridName: { color: '#e5e5e5', fontSize: 13, fontWeight: '600', textAlign: 'center' },
    gridCount: { color: '#555', fontSize: 11, marginTop: 3 },
    menuTitle: { color: '#555', fontSize: 13, fontWeight: '600', textAlign: 'center', marginBottom: 8, paddingHorizontal: 20 },
    menuRow: { paddingVertical: 16, borderTopWidth: 1, borderTopColor: '#1a1a1a', paddingHorizontal: 20 },
    menuRowText: { color: '#e5e5e5', fontSize: 16, textAlign: 'center' },
});
