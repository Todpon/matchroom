import { initializeApp } from 'firebase/app'
import { getFirestore } from 'firebase/firestore'
import { getAuth } from 'firebase/auth'

const firebaseConfig = {
  apiKey: "AIzaSyBK0NmOb15nlEtRlYJPgIl7uAHxQhgLkdk",
  authDomain: "matchroom-3561f.firebaseapp.com",
  projectId: "matchroom-3561f",
  storageBucket: "matchroom-3561f.firebasestorage.app",
  messagingSenderId: "147521024453",
  appId: "1:147521024453:web:715a993478ee7f6cbc1bac"
};

export const app = initializeApp(firebaseConfig)
export const db = getFirestore(app)
export const auth = getAuth(app)