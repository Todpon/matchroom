<script setup lang="ts">
import { ref, computed, onUnmounted } from "vue";
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
} from "firebase/firestore";

import { ElMessage } from "element-plus";
import { makePairs } from "./utils/pairing";

const meName = ref("");
const joinName = ref("");
const joinRoomId = ref("");

const roomId = ref<string>("");
const room = ref<any>(null);
const members = ref<any[]>([]);
const pairs = ref<any[]>([]);

const isHost = computed(() => room.value?.hostUid === auth.currentUser?.uid);

let unsubRoom: any, unsubMembers: any, unsubPairs: any;

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    await signInAnonymously(auth);
  }
});

async function createRoom() {
  if (!meName.value.trim()) return ElMessage.error("กรุณาใส่ชื่อ");
  await ensureLogin(meName.value);

  const roomRef = await addDoc(collection(db, "rooms"), {
    name: `ห้องของ ${meName.value}`,
    hostUid: auth.currentUser!.uid,
    status: "open",
    createdAt: Date.now(),
  });

  // ลงทะเบียนสมาชิก (host)
  await setDoc(doc(db, "rooms", roomRef.id, "members", auth.currentUser!.uid), {
    displayName: meName.value,
    joinedAt: Date.now(),
    isHost: true,
    active: true,
  });

  await enterRoom(roomRef.id);
  ElMessage.success("สร้างห้องสำเร็จ!");
}

async function joinRoom() {
  if (!joinName.value.trim() || !joinRoomId.value.trim()) {
    return ElMessage.error("กรุณาใส่ชื่อและรหัสห้อง");
  }
  await ensureLogin(joinName.value);

  await setDoc(
    doc(db, "rooms", joinRoomId.value, "members", auth.currentUser!.uid),
    {
      displayName: joinName.value,
      joinedAt: Date.now(),
      isHost: false,
      active: true,
    },
    { merge: true }
  );

  await enterRoom(joinRoomId.value);
  ElMessage.success("เข้าร่วมห้องสำเร็จ!");
}

async function enterRoom(id: string) {
  // ยกเลิก sub เก่า
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
    members.value = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  });
  unsubPairs = onSnapshot(collection(roomRef, "pairs"), (snap) => {
    pairs.value = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => a.index - b.index);
  });
}

async function ensureLogin(displayName: string) {
  if (!auth.currentUser) {
    await signInAnonymously(auth);
  }
  if (auth.currentUser && !auth.currentUser.displayName) {
    try {
      await updateProfile(auth.currentUser, { displayName });
    } catch {}
  }
}

async function startPairing() {
  if (!isHost.value) return;
  if (!roomId.value) return;

  const roomRef = doc(db, "rooms", roomId.value);
  const membersCol = collection(roomRef, "members");
  const pairsCol = collection(roomRef, "pairs");

  const ms = await getDocs(membersCol);
  const uids = ms.docs.map((d) => d.id);
  if (uids.length < 2) return ElMessage.error("ต้องมีอย่างน้อย 2 คน");

  const result = makePairs(uids, true);

  await runTransaction(db, async (trx) => {
    const roomSnap = await trx.get(roomRef);
    if (!roomSnap.exists()) throw new Error("ไม่พบห้อง");

    const roomData = roomSnap.data() as any;
    if (roomData.hostUid !== auth.currentUser!.uid)
      throw new Error("เฉพาะหัวห้องเท่านั้น");
    if (roomData.status !== "open") throw new Error("ห้องไม่ได้อยู่สถานะ open");

    // ล็อกห้องก่อน
    trx.update(roomRef, { status: "locked", startedAt: Date.now() });

    // ลบคู่เดิมทั้งหมด
    const existing = await getDocs(pairsCol);
    existing.forEach((docSnap) => trx.delete(docSnap.ref));

    // เขียนคู่ใหม่
    result.forEach((members, idx) => {
      const newRef = doc(pairsCol);
      trx.set(newRef, { members, index: idx + 1 });
    });

    // สถานะเป็น paired
    trx.update(roomRef, { status: "paired" });
  });

  ElMessage.success("จับคู่สำเร็จ!");
}

onUnmounted(() => {
  unsubRoom?.();
  unsubMembers?.();
  unsubPairs?.();
});
</script>

<template>
  <section class="max-w-4xl mx-auto p-6">
    <header class="flex items-center justify-between mb-6">
      <h1 class="text-2xl font-bold text-brand">MatchRoom</h1>
      <div v-if="room" class="text-sm text-gray-600">
        รหัสห้อง: <b>{{ roomId }}</b>
      </div>
    </header>

    <!-- ก่อนเข้าห้อง -->
    <div v-if="!room" class="grid sm:grid-cols-2 gap-4">
      <div class="bg-white rounded-2xl shadow p-5">
        <h3 class="font-semibold mb-3">สร้างห้อง</h3>
        <el-input v-model="meName" placeholder="ชื่อของคุณ" class="mb-3" />
        <el-button type="success" round @click="createRoom">เริ่มเลย</el-button>
      </div>
      <div class="bg-white rounded-2xl shadow p-5">
        <h3 class="font-semibold mb-3">เข้าร่วมห้อง</h3>
        <el-input v-model="joinName" placeholder="ชื่อของคุณ" class="mb-3" />
        <el-input v-model="joinRoomId" placeholder="รหัสห้อง" class="mb-3" />
        <el-button type="primary" round @click="joinRoom">เข้าร่วม</el-button>
      </div>
    </div>

    <!-- ในห้อง -->
    <div v-else class="space-y-4">
      <div
        class="bg-white rounded-2xl shadow p-5 flex items-center justify-between"
      >
        <div class="font-medium">
          สถานะ: <el-tag size="small">{{ room.status }}</el-tag>
        </div>
        <div v-if="isHost" class="space-x-2">
          <el-button
            type="primary"
            round
            :disabled="members.length < 2 || room.status !== 'open'"
            @click="startPairing"
            >เริ่มจับคู่</el-button
          >
        </div>
      </div>

      <div class="grid sm:grid-cols-2 gap-4">
        <div class="bg-white rounded-2xl shadow p-5">
          <h3 class="font-semibold mb-3">สมาชิก ({{ members.length }})</h3>
          <div class="grid gap-2">
            <div
              v-for="m in members"
              :key="m.id"
              class="flex items-center justify-between p-3 rounded-xl border"
            >
              <div class="flex items-center gap-3">
                <div
                  class="w-9 h-9 rounded-full bg-brand/10 flex items-center justify-center font-bold text-brand"
                >
                  {{ m.displayName?.[0]?.toUpperCase() || "U" }}
                </div>
                <div class="font-medium">{{ m.displayName }}</div>
              </div>
              <el-tag v-if="m.isHost" type="success" size="small">Host</el-tag>
            </div>
          </div>
        </div>

        <div class="bg-white rounded-2xl shadow p-5" v-if="pairs.length">
          <h3 class="font-semibold mb-3">ผลจับคู่</h3>
          <div class="space-y-2">
            <div
              v-for="p in pairs"
              :key="p.id"
              class="p-3 rounded-xl border flex items-center justify-between"
            >
              <div class="text-gray-500">#{{ p.index }}</div>
              <div class="font-semibold">
                {{ p.members.join(" • ") }}
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
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped></style>
