import { Ionicons } from '@expo/vector-icons';
import type { ComponentProps, ReactNode } from 'react';
import { ActivityIndicator, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View, type TextInputProps, type ViewStyle } from 'react-native';
import { initials } from './format';
import { color, radius, space } from './theme';

type Tone = 'brand' | 'ok' | 'warn' | 'bad' | 'info' | 'neutral';
const TONES: Record<Tone, { bg: string; fg: string }> = {
  brand: { bg: color.mint, fg: color.brand600 },
  ok: { bg: color.okBg, fg: color.ok },
  warn: { bg: color.warnBg, fg: color.warn },
  bad: { bg: color.badBg, fg: color.bad },
  info: { bg: color.infoBg, fg: color.info },
  neutral: { bg: color.head, fg: color.muted },
};

export function Screen({ children, onRefresh, refreshing }: { children: ReactNode; onRefresh?: () => void; refreshing?: boolean }) {
  return (
    <ScrollView
      style={s.screen}
      contentContainerStyle={s.screenBody}
      keyboardShouldPersistTaps="handled"
      refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={color.brand600} /> : undefined}
    >
      {children}
    </ScrollView>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[s.card, style]}>{children}</View>;
}

/** A page that slides up over the screen, for choosing something or filling a short form. */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: color.canvas }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', padding: space.lg, backgroundColor: color.surface, borderBottomWidth: 1, borderBottomColor: color.line }}>
          <Text style={{ flex: 1, fontSize: 17, fontWeight: '800', color: color.ink }} numberOfLines={2}>{title}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} hitSlop={12}><Ionicons name="close" size={26} color={color.ink} /></Pressable>
        </View>
        <ScrollView contentContainerStyle={s.screenBody} keyboardShouldPersistTaps="handled">{children}</ScrollView>
      </View>
    </Modal>
  );
}

export function Title({ children }: { children: ReactNode }) {
  return <Text style={s.title}>{children}</Text>;
}

export function Muted({ children, style }: { children: ReactNode; style?: object }) {
  return <Text style={[s.muted, style]}>{children}</Text>;
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: Tone }) {
  const t = TONES[tone];
  return (
    <View style={[s.badge, { backgroundColor: t.bg }]}>
      <Text style={[s.badgeText, { color: t.fg }]}>{children}</Text>
    </View>
  );
}

export function Button({ title, onPress, variant = 'primary', loading, disabled, icon }: {
  title: string; onPress: () => void; variant?: 'primary' | 'secondary' | 'danger'; loading?: boolean; disabled?: boolean; icon?: ComponentProps<typeof Ionicons>['name'];
}) {
  const off = disabled || loading;
  const bg = variant === 'primary' ? color.brand600 : variant === 'danger' ? color.bad : color.surface;
  const fg = variant === 'secondary' ? color.ink : '#fff';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!off, busy: !!loading }}
      onPress={off ? undefined : onPress}
      style={({ pressed }) => [s.button, { backgroundColor: bg, opacity: off ? 0.5 : pressed ? 0.85 : 1 }, variant === 'secondary' && s.buttonOutline]}
    >
      {loading ? <ActivityIndicator color={fg} /> : (
        <>
          {icon && <Ionicons name={icon} size={18} color={fg} />}
          <Text style={[s.buttonText, { color: fg }]}>{title}</Text>
        </>
      )}
    </Pressable>
  );
}

export function Field({ label, error, ...input }: TextInputProps & { label: string; error?: string }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={s.label}>{label}</Text>
      <TextInput placeholderTextColor={color.subtle} style={[s.input, !!error && { borderColor: color.bad }]} {...input} />
      {!!error && <Text style={{ color: color.bad, fontSize: 12 }}>{error}</Text>}
    </View>
  );
}

export function Notice({ tone = 'info', children }: { tone?: 'ok' | 'bad' | 'warn' | 'info'; children: ReactNode }) {
  const t = TONES[tone];
  return (
    <View style={[s.notice, { backgroundColor: t.bg }]} accessibilityRole="alert">
      <Text style={{ color: t.fg, fontSize: 14 }}>{children}</Text>
    </View>
  );
}

export function Avatar({ name, size = 40 }: { name: string; size?: number }) {
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color.mint, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: color.brand, fontWeight: '700', fontSize: size * 0.38 }}>{initials(name)}</Text>
    </View>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <View style={{ alignItems: 'center', padding: space.xl, gap: 4 }}>
      <Text style={{ color: color.ink, fontWeight: '600' }}>{title}</Text>
      {!!hint && <Text style={s.muted}>{hint}</Text>}
    </View>
  );
}

export function Spinner() {
  return <View style={{ padding: space.xl }}><ActivityIndicator color={color.brand600} /></View>;
}

export function Row({ label, value }: { label: string; value?: ReactNode }) {
  return (
    <View style={s.row}>
      <Text style={s.muted}>{label}</Text>
      <Text style={{ color: color.ink, fontWeight: '600', flexShrink: 1, textAlign: 'right' }}>{value || '—'}</Text>
    </View>
  );
}

/** A chip row for choosing one value, such as a queue or a status. */
export function Chips<T extends string>({ options, value, onChange }: { options: { key: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm, paddingVertical: 2 }}>
      {options.map((o) => {
        const on = o.key === value;
        return (
          <Pressable key={o.key} accessibilityRole="button" accessibilityState={{ selected: on }} onPress={() => onChange(o.key)} style={[s.chip, on && s.chipOn]}>
            <Text style={{ color: on ? '#fff' : color.ink, fontWeight: '600', fontSize: 13 }}>{o.label}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.canvas },
  screenBody: { padding: space.lg, gap: space.md, paddingBottom: 48 },
  card: { backgroundColor: color.surface, borderRadius: radius.md, borderWidth: 1, borderColor: color.line, padding: space.lg, gap: space.sm },
  title: { fontSize: 16, fontWeight: '700', color: color.ink },
  muted: { fontSize: 13, color: color.muted },
  badge: { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.pill },
  badgeText: { fontSize: 12, fontWeight: '600' },
  button: { minHeight: 48, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, paddingHorizontal: space.lg },
  buttonOutline: { borderWidth: 1, borderColor: color.lineStrong },
  buttonText: { fontSize: 15, fontWeight: '700' },
  label: { fontSize: 13, fontWeight: '600', color: color.ink },
  input: { minHeight: 48, borderWidth: 1, borderColor: color.lineStrong, borderRadius: radius.md, paddingHorizontal: space.md, fontSize: 16, color: color.ink, backgroundColor: color.surface },
  notice: { padding: space.md, borderRadius: radius.md },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: space.lg, paddingVertical: 6 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.pill, backgroundColor: color.head },
  chipOn: { backgroundColor: color.brand600 },
});
