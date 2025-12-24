// Firebase Configuration
// Replace these values with your own Firebase project credentials
// Get these from: https://console.firebase.google.com -> Project Settings -> Your Apps

const firebaseConfig = {
    apiKey: "YOUR_API_KEY",
    authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
    projectId: "YOUR_PROJECT_ID",
    storageBucket: "YOUR_PROJECT_ID.appspot.com",
    messagingSenderId: "YOUR_SENDER_ID",
    appId: "YOUR_APP_ID",
    databaseURL: "https://YOUR_PROJECT_ID-default-rtdb.firebaseio.com"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);

// Initialize services
const auth = firebase.auth();
const db = firebase.firestore();
const rtdb = firebase.database();

// Enable offline persistence for Firestore
db.enablePersistence().catch((err) => {
    if (err.code === 'failed-precondition') {
        console.log('Multiple tabs open, persistence only works in one tab at a time.');
    } else if (err.code === 'unimplemented') {
        console.log('Browser does not support persistence.');
    }
});

console.log('Firebase initialized successfully');
