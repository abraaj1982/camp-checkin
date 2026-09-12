import { useEffect } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useApp } from "@/state/AppContext";
import { colors } from "@/theme/colors";
import { OrderStatus } from "@/types";

const STEPS: { key: OrderStatus; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { key: "driver_assigned", label: "تم تعيين السائق", icon: "person-outline" },
  { key: "picked_up", label: "تم استلام الطرد", icon: "cube-outline" },
  { key: "on_the_way", label: "في الطريق إليك", icon: "car-outline" },
  { key: "delivered", label: "تم التسليم", icon: "checkmark-done-outline" },
];

export default function TrackingScreen() {
  const { activeOrder, advanceOrderStatus, resetOrder } = useApp();

  useEffect(() => {
    if (!activeOrder || activeOrder.status === "delivered") return;
    const timer = setTimeout(() => advanceOrderStatus(), 4000);
    return () => clearTimeout(timer);
  }, [activeOrder?.status]);

  if (!activeOrder || !activeOrder.driver) {
    router.replace("/home");
    return null;
  }

  const { driver, status } = activeOrder;
  const currentIdx = STEPS.findIndex((s) => s.key === status);

  const finish = () => {
    resetOrder();
    router.replace("/home");
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.replace("/home")}>
          <Ionicons name="chevron-forward" size={26} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.title}>تتبع الطلب</Text>
        <View style={{ width: 26 }} />
      </View>

      <View style={styles.driverCard}>
        <View style={[styles.avatar, { backgroundColor: driver.avatarColor }]}>
          <Text style={styles.avatarText}>{driver.name.charAt(0)}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.driverName}>{driver.name}</Text>
          <Text style={styles.driverMeta}>
            {driver.vehicle} · ⭐ {driver.rating}
          </Text>
        </View>
        <View style={styles.priceBox}>
          <Text style={styles.priceText}>{driver.price.toFixed(2)} ر.ع</Text>
        </View>
      </View>

      <View style={styles.stepsCard}>
        {STEPS.map((step, idx) => {
          const done = idx <= currentIdx;
          return (
            <View key={step.key} style={styles.stepRow}>
              <View style={styles.stepIconCol}>
                <View
                  style={[
                    styles.stepDot,
                    done && { backgroundColor: colors.primary },
                  ]}
                >
                  <Ionicons
                    name={step.icon}
                    size={16}
                    color={done ? "#fff" : colors.textMuted}
                  />
                </View>
                {idx < STEPS.length - 1 && (
                  <View
                    style={[
                      styles.stepLine,
                      idx < currentIdx && { backgroundColor: colors.primary },
                    ]}
                  />
                )}
              </View>
              <Text
                style={[
                  styles.stepLabel,
                  done && { color: colors.text, fontWeight: "700" },
                ]}
              >
                {step.label}
              </Text>
            </View>
          );
        })}
      </View>

      <View style={styles.routeCard}>
        <Text style={styles.routeText}>من: {activeOrder.pickup}</Text>
        <Text style={styles.routeText}>إلى: {activeOrder.dropoff}</Text>
      </View>

      {status === "delivered" && (
        <TouchableOpacity style={styles.doneButton} onPress={finish}>
          <Text style={styles.doneButtonText}>تم — رجوع للرئيسية</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, paddingTop: 56, padding: 20, gap: 16 },
  header: {
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    alignItems: "center",
  },
  title: { fontSize: 18, fontWeight: "800", color: colors.text },
  driverCard: {
    flexDirection: "row-reverse",
    alignItems: "center",
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 12,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: "#fff", fontWeight: "800", fontSize: 18 },
  driverName: { fontSize: 15, fontWeight: "700", color: colors.text, textAlign: "right" },
  driverMeta: { fontSize: 12, color: colors.textMuted, textAlign: "right" },
  priceBox: { alignItems: "center" },
  priceText: { fontSize: 14, fontWeight: "800", color: colors.primary },
  stepsCard: {
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: 18,
    borderWidth: 1,
    borderColor: colors.border,
  },
  stepRow: { flexDirection: "row-reverse", alignItems: "flex-start", gap: 12 },
  stepIconCol: { alignItems: "center" },
  stepDot: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  stepLine: { width: 2, flex: 1, minHeight: 24, backgroundColor: colors.border },
  stepLabel: {
    flex: 1,
    textAlign: "right",
    color: colors.textMuted,
    fontSize: 14,
    paddingTop: 6,
    paddingBottom: 18,
  },
  routeCard: {
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    gap: 6,
  },
  routeText: { textAlign: "right", fontSize: 13, color: colors.textMuted },
  doneButton: {
    backgroundColor: colors.primary,
    borderRadius: 16,
    paddingVertical: 16,
    alignItems: "center",
  },
  doneButtonText: { color: "#fff", fontSize: 16, fontWeight: "700" },
});
