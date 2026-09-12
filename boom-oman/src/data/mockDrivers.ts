import { Driver } from "@/types";

const OMANI_NAMES = [
  "سالم الحارثي",
  "ريان البلوشي",
  "خالد السعدي",
  "فهد المعمري",
  "بدر الكندي",
];

const VEHICLES = ["سيارة صغيرة", "بيك أب", "دراجة نارية", "فان"];

export function generateOffers(seed: number): Driver[] {
  const count = 3 + (seed % 3);
  return Array.from({ length: count }).map((_, i) => {
    const basePrice = 1.2 + ((seed + i) % 5) * 0.35;
    return {
      id: `drv-${seed}-${i}`,
      name: OMANI_NAMES[(seed + i) % OMANI_NAMES.length],
      rating: Number((3.9 + ((seed + i) % 10) / 10).toFixed(1)),
      trips: 40 + ((seed + i * 7) % 400),
      vehicle: VEHICLES[(seed + i) % VEHICLES.length],
      etaMinutes: 4 + ((seed + i * 3) % 15),
      price: Number(basePrice.toFixed(2)),
      avatarColor: ["#7C3AED", "#F59E0B", "#22C55E", "#0EA5E9", "#EF4444"][
        (seed + i) % 5
      ],
    };
  });
}
