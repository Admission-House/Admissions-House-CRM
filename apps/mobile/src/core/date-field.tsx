import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { fmtDate, fmtDateTime } from './format';
import { color, radius, space } from './theme';

/** Picks a date (and optionally a time). Android shows two dialogs in turn; iOS shows one inline control. */
export function DateField({ label, value, onChange, withTime = false, minimum }: {
  label: string; value: Date | null; onChange: (d: Date) => void; withTime?: boolean; minimum?: Date;
}) {
  const [iosOpen, setIosOpen] = useState(false);
  const shown = value ? (withTime ? fmtDateTime(value) : fmtDate(value)) : 'Choose';

  function open() {
    if (Platform.OS === 'ios') { setIosOpen((o) => !o); return; }
    const base = value ?? new Date();
    DateTimePickerAndroid.open({
      value: base, mode: 'date', minimumDate: minimum,
      onChange: (e, date) => {
        if (e.type !== 'set' || !date) return;
        if (!withTime) { onChange(date); return; }
        DateTimePickerAndroid.open({
          value: date, mode: 'time',
          onChange: (e2, t) => {
            if (e2.type !== 'set' || !t) return;
            const out = new Date(date);
            out.setHours(t.getHours(), t.getMinutes(), 0, 0);
            onChange(out);
          },
        });
      },
    });
  }

  return (
    <View style={{ gap: 6 }}>
      <Text style={s.label}>{label}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={`${label}: ${shown}`} onPress={open} style={s.box}>
        <Text style={{ color: value ? color.ink : color.subtle, fontSize: 16 }}>{shown}</Text>
      </Pressable>
      {Platform.OS === 'ios' && iosOpen && (
        <DateTimePicker value={value ?? new Date()} mode={withTime ? 'datetime' : 'date'} display="inline" minimumDate={minimum} onChange={(_e, d) => d && onChange(d)} />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  label: { fontSize: 13, fontWeight: '600', color: color.ink },
  box: { minHeight: 48, justifyContent: 'center', borderWidth: 1, borderColor: color.lineStrong, borderRadius: radius.md, paddingHorizontal: space.md, backgroundColor: color.surface },
});
