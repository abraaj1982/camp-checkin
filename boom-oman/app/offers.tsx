import { FlatList, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useApp } from "@/state/AppContext";
import { colors } from "@/theme/colors";
import { Driver } from "@/types";

export default function OffersScreen() {
  const { offers, activeOrder, chooseDriver } = useApp();

  if (!activeOrder) {
    router.replace("/home");
    return null;
  }

  const select = (driver: Driver) => {
    chooseDriver(driver);
    router.replace("/tracking");
  };

  const sorted = [...offers].sort((a, b) => a.price - b.price);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <Ionicons name="chevron-forward" size={26} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.title}>اختر السائق</Text>
        <View style={{ width: 26 }} />
      </View>

      <View style={styles.routeCard}>
        <Text style={styles.routeText} numberOfLines={1}>
          من: {activeOrder.pickup}
        </Text>
        <Text style={styles.routeText} numberOfLines={1}>
          إلى: {activeOrder.dropoff}
        </Text>
      </View>

      <FlatList
        data={sorted}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.driverCard} onPress={() => select(item)}>
            <View style={[styles.avatar, { backgroundColor: item.avatarColor }]}>
              <Text style={styles.avatarText}>{item.name.charAt(0)}</Text>
            </View>
            <View style={styles.driverInfo}>
              <Text style={styles.driverName}>{item.name}</Text>
              <Text style={styles.driverMeta}>
                {item.vehicle} · {item.trips} رحلة
              </Text>
              <View style={styles.ratingRow}>
                <Ionicons name="star" size={13} color={colors.warning} />
                <Text style={styles.ratingText}>{item.rating}</Text>
                <Text style={styles.etaText}>· يصل خلال {item.etaMinutes} د</Text>
              </View>
            </View>
            <View style={styles.priceBox}>
              <Text style={styles.priceText}>{item.price.toFixed(2)}</Text>
              <Text style={styles.priceCurrency}>ر.ع</Text>
            </View>
          </TouchableOpacity>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, paddingTop: 56 },
  header: {
    flexDirection: "row-reverse",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 20,
  },
  title: { fontSize: 18, fontWeight: "800", color: colors.text },
  routeCard: {
    margin: 20,
    marginBottom: 8,
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    gap: 6,
  },
  routeText: { textAlign: "right", fontSize: 13, color: colors.textMuted },
  list: { padding: 20, gap: 12 },
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
  driverInfo: { flex: 1, gap: 3 },
  driverName: { fontSize: 15, fontWeight: "700", color: colors.text, textAlign: "right" },
  driverMeta: { fontSize: 12, color: colors.textMuted, textAlign: "right" },
  ratingRow: { flexDirection: "row-reverse", alignItems: "center", gap: 4 },
  ratingText: { fontSize: 12, fontWeight: "700", color: colors.text },
  etaText: { fontSize: 12, color: colors.textMuted },
  priceBox: { alignItems: "center" },
  priceText: { fontSize: 18, fontWeight: "800", color: colors.primary },
  priceCurrency: { fontSize: 10, color: colors.textMuted },
});
