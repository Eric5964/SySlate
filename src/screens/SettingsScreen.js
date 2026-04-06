import React, { useState, useEffect, useContext } from 'react';
import {
  View, Text, StyleSheet, ScrollView,
  Switch, TouchableOpacity, StatusBar,
} from 'react-native';
import Slider from '@react-native-community/slider';
import { usePlayback } from '../context/PlaybackContext';
import { LibraryContext } from '../App';
import {
  getCrossfade, setCrossfade,
  getSkipCrossfade, setSkipCrossfade,
  getVolNorm, setVolNorm,
} from '../utils/storage';

export default function SettingsScreen() {
  const { shuffleMode, changeShuffleMode } = usePlayback();
  const { reload } = useContext(LibraryContext);
  const [cf,      setCf]      = useState(3.0);
  const [skipCf,  setSkipCf]  = useState(0.5);
  const [volNorm, setVN]      = useState(true);

  useEffect(() => {
    (async () => {
      setCf(await getCrossfade());
      setSkipCf(await getSkipCrossfade());
      setVN(await getVolNorm());
    })();
  }, []);

  const MODES = [
    { id: 'off',         label: 'Off',         sub: 'Play in folder order' },
    { id: 'full_cycle',  label: 'Full Cycle',  sub: 'All songs once before repeat' },
    { id: 'true_random', label: 'True Random', sub: 'Completely random, may repeat' },
    { id: 'smart',       label: 'Smart',       sub: 'Avoids same artist back to back' },
  ];

  return (
    <ScrollView style={s.container} contentContainerStyle={{ paddingBottom: 120 }}>
      <StatusBar barStyle="light-content" />
      <View style={s.header}><Text style={s.title}>Settings</Text></View>

      <Section title="Library">
        <Row label="Rescan Music Folders" sub="Re-reads Files → On My iPhone → SySlate" onPress={reload} />
      </Section>

      <Section title="Shuffle Mode">
        {MODES.map(m => (
          <TouchableOpacity key={m.id} style={s.modeRow} onPress={() => changeShuffleMode(m.id)}>
            <View style={{ flex: 1 }}>
              <Text style={s.modeLabel}>{m.label}</Text>
              <Text style={s.modeSub}>{m.sub}</Text>
            </View>
            <View style={[s.radio, shuffleMode === m.id && s.radioOn]} />
          </TouchableOpacity>
        ))}
      </Section>

      <Section title="Crossfade — Track End">
        <Text style={s.sliderSub}>Fades out when a track naturally finishes</Text>
        <Text style={s.sliderVal}>{cf.toFixed(1)}s</Text>
        <Slider
          style={s.slider}
          minimumValue={0} maximumValue={12} step={0.5}
          value={cf}
          onValueChange={setCf}
          onSlidingComplete={v => { setCf(v); setCrossfade(v); }}
          minimumTrackTintColor="#7c3aed"
          maximumTrackTintColor="#222"
          thumbTintColor="#7c3aed"
        />
        <View style={s.sliderEnds}><Text style={s.sliderEnd}>0s</Text><Text style={s.sliderEnd}>12s</Text></View>
      </Section>

      <Section title="Crossfade — Skip">
        <Text style={s.sliderSub}>Softens the cut when you skip manually</Text>
        <Text style={s.sliderVal}>{skipCf.toFixed(1)}s</Text>
        <Slider
          style={s.slider}
          minimumValue={0} maximumValue={3} step={0.5}
          value={skipCf}
          onValueChange={setSkipCf}
          onSlidingComplete={v => { setSkipCf(v); setSkipCrossfade(v); }}
          minimumTrackTintColor="#7c3aed"
          maximumTrackTintColor="#222"
          thumbTintColor="#7c3aed"
        />
        <View style={s.sliderEnds}><Text style={s.sliderEnd}>0s</Text><Text style={s.sliderEnd}>3s</Text></View>
      </Section>

      <Section title="Audio">
        <View style={s.toggleRow}>
          <View style={{ flex: 1 }}>
            <Text style={s.toggleLabel}>Volume Normalization</Text>
            <Text style={s.toggleSub}>Equalizes loudness between tracks</Text>
          </View>
          <Switch
            value={volNorm}
            onValueChange={v => { setVN(v); setVolNorm(v); }}
            trackColor={{ false: '#222', true: '#7c3aed' }}
            thumbColor="#fff"
          />
        </View>
      </Section>
    </ScrollView>
  );
}

function Section({ title, children }) {
  return (
    <View style={s.section}>
      <Text style={s.sectionLabel}>{title}</Text>
      <View style={s.sectionBody}>{children}</View>
    </View>
  );
}

function Row({ label, sub, onPress }) {
  return (
    <TouchableOpacity style={s.row} onPress={onPress}>
      <Text style={s.rowLabel}>{label}</Text>
      {sub ? <Text style={s.rowSub}>{sub}</Text> : null}
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  container:    { flex: 1, backgroundColor: '#0a0a0a' },
  header:       { paddingTop: 60, paddingHorizontal: 24, paddingBottom: 20 },
  title:        { color: '#e5e5e5', fontSize: 28, fontWeight: '700' },
  section:      { marginBottom: 24 },
  sectionLabel: { color: '#555', fontSize: 11, fontWeight: '600', letterSpacing: 1, textTransform: 'uppercase', paddingHorizontal: 24, marginBottom: 4 },
  sectionBody:  { backgroundColor: '#0f0f0f', borderTopWidth: 1, borderBottomWidth: 1, borderColor: '#1a1a1a' },
  row:          { paddingVertical: 14, paddingHorizontal: 24, borderBottomWidth: 1, borderBottomColor: '#141414' },
  rowLabel:     { color: '#e5e5e5', fontSize: 15, fontWeight: '500' },
  rowSub:       { color: '#555', fontSize: 12, marginTop: 3 },
  modeRow:      { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 24, borderBottomWidth: 1, borderBottomColor: '#141414' },
  modeLabel:    { color: '#e5e5e5', fontSize: 15, fontWeight: '500' },
  modeSub:      { color: '#555', fontSize: 12, marginTop: 2 },
  radio:        { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: '#333' },
  radioOn:      { borderColor: '#7c3aed', backgroundColor: '#7c3aed' },
  sliderSub:    { color: '#555', fontSize: 12, paddingHorizontal: 24, paddingTop: 12 },
  sliderVal:    { color: '#7c3aed', fontSize: 22, fontWeight: '700', textAlign: 'center', marginTop: 8 },
  slider:       { marginHorizontal: 16, marginTop: 4 },
  sliderEnds:   { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 24, paddingBottom: 12 },
  sliderEnd:    { color: '#444', fontSize: 11 },
  toggleRow:    { flexDirection: 'row', alignItems: 'center', padding: 16, paddingHorizontal: 24 },
  toggleLabel:  { color: '#e5e5e5', fontSize: 15, fontWeight: '500' },
  toggleSub:    { color: '#555', fontSize: 12, marginTop: 3 },
});