<script setup lang="ts">
import { ref, computed, onUnmounted, watch } from "vue";
import { auth, db } from "./firebase";
import {
  signInAnonymously,
  onAuthStateChanged,
  updateProfile,
} from "firebase/auth";
import {
  doc,
  collection,
  setDoc,
  addDoc,
  onSnapshot,
  runTransaction,
  getDocs,
  writeBatch,
  serverTimestamp,
} from "firebase/firestore";
import { ElMessage } from "element-plus";
import { makePairs } from "./utils/pairing";

// -------- state --------
const meName = ref("");
const joinName = ref("");
const joinRoomId = ref("");

const roomId = ref<string>("");
const room = ref<any>(null);
const members = ref<any[]>([]);
const pairs = ref<any[]>([]);

const isHost = computed(() => room.value?.hostUid === auth.currentUser?.uid);
const meUid = computed(() => auth.currentUser?.uid || "");

// map uid -> displayName เพื่อโชว์ชื่อจริง
const nameByUid = computed<Record<string, string>>(() =>
  Object.fromEntries(members.value.map((m) => [m.id, m.displayName || m.id]))
);

// คู่ของฉัน (หา pair ที่มี uid ของเรา)
const myPair = computed(() => {
  const uid = meUid.value;
  if (!uid) return null;
  const p = pairs.value.find((p) => (p.members as string[]).includes(uid));
  if (!p) return null;
  return { index: p.index, members: p.members as string[] };
});

// Dialog แจ้งผลจับคู่ของฉัน
const showMyPairDialog = ref(false);
watch(
  () => pairs.value.map((p) => p.id).join(","), // trigger เมื่อมีผลคู่ใหม่
  () => {
    if (room.value?.status === "paired" && myPair.value) {
      showMyPairDialog.value = true;
    }
  }
);

// -------- auth --------
onAuthStateChanged(auth, async (user) => {
  if (!user) await signInAnonymously(auth);
});

async function ensureLogin(displayName: string) {
  if (!auth.currentUser) await signInAnonymously(auth);
  if (auth.currentUser && !auth.currentUser.displayName) {
    try {
      await updateProfile(auth.currentUser, { displayName });
    } catch {}
  }
}

// -------- room flow --------
async function createRoom() {
  try {
    if (!meName.value.trim()) return ElMessage.error("กรุณาใส่ชื่อ");
    await ensureLogin(meName.value);

    const roomRef = await addDoc(collection(db, "rooms"), {
      name: `ห้องของ ${meName.value}`,
      hostUid: auth.currentUser!.uid,
      status: "open",
      createdAt: serverTimestamp(),
    });

    await setDoc(
      doc(db, "rooms", roomRef.id, "members", auth.currentUser!.uid),
      {
        displayName: meName.value,
        joinedAt: serverTimestamp(),
        isHost: true,
        active: true,
      }
    );

    await enterRoom(roomRef.id);
    ElMessage.success("สร้างห้องสำเร็จ!");
  } catch (e: any) {
    console.error(e);
    ElMessage.error(e?.message || "สร้างห้องไม่สำเร็จ");
  }
}

async function joinRoom() {
  try {
    if (!joinName.value.trim() || !joinRoomId.value.trim()) {
      return ElMessage.error("กรุณาใส่ชื่อและรหัสห้อง");
    }
    await ensureLogin(joinName.value);

    await setDoc(
      doc(db, "rooms", joinRoomId.value, "members", auth.currentUser!.uid),
      {
        displayName: joinName.value,
        joinedAt: serverTimestamp(),
        isHost: false,
        active: true,
      },
      { merge: true }
    );

    await enterRoom(joinRoomId.value);
    ElMessage.success("เข้าร่วมห้องสำเร็จ!");
  } catch (e: any) {
    console.error(e);
    ElMessage.error(e?.message || "เข้าห้องไม่สำเร็จ");
  }
}

let unsubRoom: any, unsubMembers: any, unsubPairs: any;
async function enterRoom(id: string) {
  unsubRoom?.();
  unsubMembers?.();
  unsubPairs?.();

  roomId.value = id;
  const roomRef = doc(db, "rooms", id);

  unsubRoom = onSnapshot(
    roomRef,
    (s) => (room.value = { id: s.id, ...s.data() })
  );
  unsubMembers = onSnapshot(collection(roomRef, "members"), (snap) => {
    members.value = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => a.displayName?.localeCompare(b.displayName) || 0);
  });
  unsubPairs = onSnapshot(collection(roomRef, "pairs"), (snap) => {
    pairs.value = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => a.index - b.index);
  });
}

onUnmounted(() => {
  unsubRoom?.();
  unsubMembers?.();
  unsubPairs?.();
});

// -------- pairing (สวย + ปลอดภัย) --------
async function startPairing() {
  try {
    if (!isHost.value) return ElMessage.error("เฉพาะหัวห้องเท่านั้น");
    if (!roomId.value) return;

    const roomRef = doc(db, "rooms", roomId.value);
    const membersCol = collection(roomRef, "members");
    const pairsCol = collection(roomRef, "pairs");

    // step 1: อ่านสมาชิก
    const ms = await getDocs(membersCol);
    const uids = ms.docs.map((d) => d.id);
    if (uids.length < 2) return ElMessage.error("ต้องมีอย่างน้อย 2 คน");

    // step 2: ล็อกห้อง
    await runTransaction(db, async (trx) => {
      const snap = await trx.get(roomRef);
      if (!snap.exists()) throw new Error("ไม่พบห้อง");
      const data = snap.data() as any;
      if (data.hostUid !== auth.currentUser!.uid)
        throw new Error("เฉพาะหัวห้องเท่านั้น");
      if (data.status !== "open") throw new Error("ห้องไม่ได้อยู่สถานะ open");
      trx.update(roomRef, { status: "locked", startedAt: serverTimestamp() });
    });

    // step 3: ลบคู่เดิม + เขียนใหม่
    const batch = writeBatch(db);
    const existing = await getDocs(pairsCol);
    existing.forEach((d) => batch.delete(d.ref));

    const result = makePairs(uids, true);
    result.forEach((members, idx) => {
      const ref = doc(pairsCol);
      batch.set(ref, { members, index: idx + 1 });
    });
    batch.update(roomRef, { status: "paired" });
    await batch.commit();

    ElMessage.success("จับคู่สำเร็จ!");
  } catch (e: any) {
    console.error(e);
    ElMessage.error(e?.message || "เริ่มจับคู่ไม่สำเร็จ");
  }
}

// กด “สุ่มใหม่” (เปลี่ยนสถานะกลับ open แล้วเรียก startPairing)
async function reshuffle() {
  if (!isHost.value) return;
  const roomRef = doc(db, "rooms", roomId.value);
  await runTransaction(db, async (trx) => {
    const snap = await trx.get(roomRef);
    if (!snap.exists()) throw new Error("ไม่พบห้อง");
    const data = snap.data() as any;
    if (data.hostUid !== auth.currentUser!.uid)
      throw new Error("เฉพาะหัวห้องเท่านั้น");
    trx.update(roomRef, { status: "open" });
  });
  await startPairing();
}

// ช่วยแสดงชื่อของแต่ละคู่แบบอ่านง่าย (ชื่อจริง)
function pairDisplay(p: any) {
  const names = (p.members as string[]).map((u) => nameByUid.value[u] || u);
  return names.join(" • ");
}

// คัดลอกรหัสห้อง
async function copyRoomId() {
  try {
    await navigator.clipboard.writeText(roomId.value);
    ElMessage.success("คัดลอกรหัสห้องแล้ว");
  } catch {
    ElMessage.error("คัดลอกไม่สำเร็จ");
  }
}
</script>

<template>
  <section class="mx-auto max-w-5xl p-4 sm:p-6">
    <!-- header -->
    <header class="mb-5 flex items-center justify-between">
      <h1 class="text-3xl font-extrabold tracking-tight" style="color: #006359">
        MatchRoom
      </h1>

      <div v-if="room" class="flex items-center gap-2 text-sm">
        <span class="text-gray-600">รหัสห้อง:</span>
        <b class="px-2 py-1 rounded bg-gray-100">{{ roomId }}</b>
        <el-button size="small" @click="copyRoomId">คัดลอก</el-button>
      </div>
    </header>

    <!-- before join/create -->
    <div v-if="!room" class="grid gap-4 sm:grid-cols-2">
      <el-card class="rounded-2xl shadow-md">
        <template #header>สร้างห้อง</template>
        <el-input v-model="meName" placeholder="ชื่อของคุณ" class="mb-3" />
        <el-button type="success" round class="w-full" @click="createRoom"
          >เริ่มเลย</el-button
        >
      </el-card>

      <el-card class="rounded-2xl shadow-md">
        <template #header>เข้าร่วมห้อง</template>
        <el-input v-model="joinName" placeholder="ชื่อของคุณ" class="mb-3" />
        <el-input v-model="joinRoomId" placeholder="รหัสห้อง" class="mb-3" />
        <el-button type="primary" round class="w-full" @click="joinRoom"
          >เข้าร่วม</el-button
        >
      </el-card>
    </div>

    <!-- in room -->
    <div v-else class="space-y-4">
      <!-- status / actions -->
      <el-card class="rounded-2xl shadow-md">
        <div
          class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
        >
          <div class="text-sm font-medium">
            สถานะ:
            <el-tag
              :type="
                room.status === 'paired'
                  ? 'success'
                  : room.status === 'locked'
                  ? 'warning'
                  : 'info'
              "
            >
              {{ room.status }}
            </el-tag>
          </div>

          <div v-if="isHost" class="flex gap-2">
            <el-button
              type="primary"
              round
              :disabled="members.length < 2 || room.status !== 'open'"
              @click="startPairing"
            >
              เริ่มจับคู่
            </el-button>
            <el-button
              type="success"
              round
              :disabled="members.length < 2 || room.status !== 'paired'"
              @click="reshuffle"
            >
              สุ่มใหม่
            </el-button>
          </div>
        </div>
      </el-card>

      <!-- content grid -->
      <div class="grid gap-4 md:grid-cols-2">
        <!-- members -->
        <el-card class="rounded-2xl shadow-md">
          <template #header>สมาชิก ({{ members.length }})</template>
          <div class="grid gap-2">
            <div
              v-for="m in members"
              :key="m.id"
              class="flex items-center justify-between rounded-xl border p-3"
            >
              <div class="flex items-center gap-3">
                <div
                  class="flex h-10 w-10 items-center justify-center rounded-full font-bold"
                  style="background: #e6f2ef; color: #006359"
                >
                  {{ m.displayName?.[0]?.toUpperCase() || "U" }}
                </div>
                <div
                  class="font-medium"
                  :class="{ 'text-brand': m.id === meUid }"
                >
                  {{ m.displayName }}
                  <span v-if="m.id === meUid" class="ml-1 text-xs text-gray-500"
                    >(ฉัน)</span
                  >
                </div>
              </div>
              <el-tag v-if="m.isHost" type="success" size="small">Host</el-tag>
            </div>
          </div>
        </el-card>

        <!-- pairs -->
        <el-card class="rounded-2xl shadow-md" v-if="pairs.length">
          <template #header>ผลจับคู่</template>
          <div class="space-y-2">
            <div
              v-for="p in pairs"
              :key="p.id"
              class="flex items-center justify-between rounded-xl border p-3"
              :class="(p.members as string[]).includes(meUid) ? 'ring-2 ring-[--brand]' : ''"
            >
              <div class="text-gray-500">#{{ p.index }}</div>
              <div class="font-semibold truncate text-right w-full px-3">
                {{ pairDisplay(p) }}
              </div>
              <el-tag v-if="p.members.length === 3" type="warning" size="small"
                >3 คน</el-tag
              >
              <el-tag
                v-else-if="p.members.length === 1"
                type="info"
                size="small"
                >บาย</el-tag
              >
            </div>
          </div>
        </el-card>
      </div>
    </div>

    <!-- mobile bottom action (host only) -->
    <div
      v-if="room && isHost"
      class="fixed inset-x-0 bottom-0 z-50 flex items-center justify-center gap-2 bg-white/90 p-3 shadow md:hidden"
    >
      <el-button
        type="primary"
        round
        :disabled="members.length < 2 || room.status !== 'open'"
        @click="startPairing"
        class="flex-1"
        >เริ่มจับคู่</el-button
      >
      <el-button
        type="success"
        round
        :disabled="members.length < 2 || room.status !== 'paired'"
        @click="reshuffle"
        class="flex-1"
        >สุ่มใหม่</el-button
      >
    </div>

    <!-- dialog: ผลจับคู่ของฉัน -->
    <el-dialog
      v-model="showMyPairDialog"
      title="ผลจับคู่ของฉัน"
      width="420px"
      align-center
    >
      <div class="space-y-2">
        <p class="text-sm text-gray-600">
          ลำดับของคุณ: <b>#{{ myPair?.index }}</b>
        </p>
        <div class="rounded-xl border p-4">
          <div class="font-semibold">
            {{
              myPair
                ? myPair.members.map((u) => nameByUid[u] || u).join(" • ")
                : ""
            }}
          </div>
          <p class="mt-1 text-xs text-gray-500">
            แชร์หน้าจอนี้ให้เพื่อนในคู่ของคุณได้
          </p>
        </div>
      </div>
      <template #footer>
        <el-button type="primary" @click="showMyPairDialog = false"
          >ตกลง</el-button
        >
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.text-brand {
  color: #006359;
}
</style>
