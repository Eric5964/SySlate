import React from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';

export default class ErrorBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { error: null, info: null };
    }

    static getDerivedStateFromError(error) {
        return { error };
    }

    componentDidCatch(error, info) {
        this.setState({ info });
    }

    render() {
        if (this.state.error) {
            return (
                <ScrollView style={styles.container} contentContainerStyle={{ padding: 20, paddingTop: 60 }}>
                    <Text style={styles.title}>Render Error</Text>
                    <Text style={styles.text}>{String(this.state.error?.message ?? this.state.error)}</Text>
                    <Text style={styles.title}>Component Stack</Text>
                    <Text style={styles.text}>{this.state.info?.componentStack ?? 'No stack available'}</Text>
                </ScrollView>
            );
        }
        return this.props.children;
    }
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#0a0a0a' },
    title: { color: '#7c3aed', fontSize: 16, fontWeight: '700', marginTop: 20, marginBottom: 8 },
    text: { color: '#e5e5e5', fontSize: 12 },
});