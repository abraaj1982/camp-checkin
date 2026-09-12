import { useState } from "react";
import {
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useApp } from "@/state/AppContext";
import { colors } from "@/theme/colors";

export default function HomeScreen() {
  const { phone, logout, requestDelivery, activeOrder } = useApp();
  const [pickup, setPickup] = useState("");
  const [dropoff, setDropoff] = useState("");
  const [note, setNote] = useState("");

  const canSubmit = pickup.trim().length > 2 && dropoff.trim().length > 2;

  const handleSubmit = () => {
    if (!canSubmit) return;
    requestDelivery(pickup.trim(), dropoff.trim(), note.trim());
    router.push("/offers");
  };

  const resumeOrder = () => {
    if (!activeOrder) return;
    router.push(activeOrder.status === "choosing_driver" ? "/offers" : "/tracking");
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
    >
      <View style={styles.topBar}>
        <TouchableOpacity onPress={logout}>
          <Ionicons name="log-out-outline" size={24} color={colors.textMuted} />
        </TouchableOpacity>
        <View style={{ alignItems: "flex-end" }}>
          <Text style={styles.greeting}>مرحبًا 👋</Text>
          <Text style={styles.phoneText}>{phone}</Text>
        </View>
      </View>

      {activeOrder && (
        <TouchableOpacity style={styles.activeBanner} onPress={resumeOrder}>
          <Ionicons name="cube-outline" size={20} color="#fff" />
          <Text style={styles.activeBannerText}>
            لديك طلب توصيل نشط — اضغط للمتابعة
          </Text>
        </TouchableOpacity>
      )}

      <View style={styles.hero}>
        <Text style={styles.heroTitle}>وين تبي توصل طردك اليوم؟</Text>
        <Text style={styles.heroSubtitle}>
          اختر السائق، قارن الأسعار، وتابع التوصيل لحظة بلحظة
        </Text>
      </View>

      <View style={styles.card}>
        <Field
          icon="ellipse-outline"
          placeholder="موقع الاستلام (مثال: مسقط، الخوض)"
          value={pickup}
          onChangeText={setPickup}
        />
        <View style={styles.divider} />
        <Field
          icon="location-outline"
          placeholder="موقع التسليم (مثال: صلالة، الديدفنيلد)"
          value={dropoff}
          onChangeText={setDropoff}
        />
        <View style={styles.divider} />
        <Field
          icon="document-text-outline"
          placeholder="ملاحظات عن الطرد (اختياري)"
          value={note}
          onChangeText={setNote}
        />
      </View>

      <TouchableOpacity
        style={[styles.submitButton, !canSubmit && styles.submitDisabled]}
        disabled={!canSubmit}
        onPress={handleSubmit}
      >
        <Text style={styles.submitText}>عرض أسعار السائقين</Text>
        <Ionicons name="arrow-back" size={20} color="#fff" />
      </TouchableOpacity>
    </ScrollView>
  );
}

function Field({
  icon,
  placeholder,
  value,
  onChangeText,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  placeholder: string;
  value: string;
  onChangeText: (v: string) => void;
}) {
  return (
    <View style={styles.fieldRow}>
      <TextInput
        style={styles.fieldInput}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        value={value}
        onChangeText={onChangeText}
        textAlign="right"
      />
      <Ionicons name={icon} size={20} color={colors.primary} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: 20, paddingTop: 60, gap: 20 },
  topBar: {
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    alignItems: "center",
  },
  greeting: { fontSize: 16, fontWeight: "700", color: colors.text },
  phoneText: { fontSize: 12, color: colors.textMuted },
  activeBanner: {
    flexDirection: "row-reverse",
    alignItems: "center",
    gap: 10,
    backgroundColor: colors.primary,
    borderRadius: 14,
    padding: 14,
  },
  activeBannerText: { color: "#fff", fontWeight: "700", flex: 1, textAlign: "right" },
  hero: { gap: 6 },
  heroTitle: { fontSize: 22, fontWeight: "800", color: colors.text, textAlign: "right" },
  heroSubtitle: { fontSize: 13, color: colors.textMuted, textAlign: "right" },
  card: {
    backgroundColor: colors.card,
    borderRadius: 18,
    padding: 6,
    borderWidth: 1,
    borderColor: colors.border,
  },
  fieldRow: {
    flexDirection: "row-reverse",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  fieldInput: { flex: 1, fontSize: 15, color: colors.text },
  divider: { height: 1, backgroundColor: colors.border, marginHorizontal: 14 },
  submitButton: {
    flexDirection: "row-reverse",
    backgroundColor: colors.primary,
    borderRadius: 16,
    paddingVertical: 16,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  submitDisabled: { opacity: 0.4 },
  submitText: { color: "#fff", fontSize: 16, fontWeight: "700" },
});
