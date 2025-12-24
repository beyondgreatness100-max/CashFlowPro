# SplitCost - Real-Time Expense Splitting App

A real-time collaborative expense splitting application built with Firebase.

## 🚀 Features

- **User Authentication** - Email/password and Google sign-in
- **Friend Management** - Add friends by email, accept/reject requests
- **Group Creation** - Create groups with custom icons and multiple members
- **Expense Tracking** - Add expenses with various split methods (equal, exact, percentage)
- **Real-Time Updates** - See expenses and settlements instantly across all devices
- **Smart Settlement** - Debt minimization algorithm for fewest transactions
- **Activity Feed** - Track all group activities in real-time

## 📁 Project Structure

```
splitcost-app/
├── index.html              # Main HTML file
├── css/
│   └── styles.css          # All styles (dark/light theme)
├── js/
│   └── app.js              # Main application logic
├── config/
│   └── firebase-config.js  # Firebase configuration
├── DATABASE_SCHEMA.md      # Database structure documentation
└── README.md               # This file
```

## 🔧 Setup Instructions

### 1. Create Firebase Project

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Click "Add Project" and follow the steps
3. Enable **Authentication**, **Firestore Database**, and **Realtime Database**

### 2. Enable Authentication Methods

1. In Firebase Console, go to **Authentication** > **Sign-in method**
2. Enable **Email/Password**
3. Enable **Google** (add your domain to authorized domains)

### 3. Create Firestore Database

1. Go to **Firestore Database** > **Create database**
2. Start in **test mode** (we'll add rules later)
3. Choose a region close to your users

### 4. Create Realtime Database

1. Go to **Realtime Database** > **Create Database**
2. Start in **test mode**
3. This is used for presence/online status

### 5. Get Firebase Configuration

1. Go to **Project Settings** > **Your apps**
2. Click the web icon (</>) to add a web app
3. Register your app and copy the config

### 6. Update Configuration

Edit `config/firebase-config.js` and replace with your values:

```javascript
const firebaseConfig = {
    apiKey: "YOUR_API_KEY",
    authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
    projectId: "YOUR_PROJECT_ID",
    storageBucket: "YOUR_PROJECT_ID.appspot.com",
    messagingSenderId: "YOUR_SENDER_ID",
    appId: "YOUR_APP_ID",
    databaseURL: "https://YOUR_PROJECT_ID-default-rtdb.firebaseio.com"
};
```

### 7. Set Security Rules

#### Firestore Rules
Go to **Firestore Database** > **Rules** and paste the rules from `DATABASE_SCHEMA.md`

#### Realtime Database Rules
Go to **Realtime Database** > **Rules**:

```json
{
  "rules": {
    "presence": {
      "$groupId": {
        ".read": "auth != null",
        ".write": "auth != null"
      }
    },
    "typing": {
      "$groupId": {
        ".read": "auth != null",
        ".write": "auth != null"
      }
    }
  }
}
```

### 8. Create Firestore Indexes

In Firebase Console, go to **Firestore Database** > **Indexes** and create:

| Collection | Fields | Query Scope |
|------------|--------|-------------|
| expenses | groupId (ASC), createdAt (DESC) | Collection |
| activities | groupId (ASC), createdAt (DESC) | Collection |
| friends | users (Arrays), status (ASC) | Collection |
| settlements | groupId (ASC), createdAt (DESC) | Collection |

### 9. Deploy (Optional)

#### Firebase Hosting
```bash
npm install -g firebase-tools
firebase login
firebase init hosting
firebase deploy
```

#### Or use any static hosting:
- Netlify
- Vercel
- GitHub Pages

## 💻 Local Development

Simply open `index.html` in your browser, or use a local server:

```bash
# Using Python
python -m http.server 8000

# Using Node.js
npx serve

# Using PHP
php -S localhost:8000
```

Then open `http://localhost:8000` in your browser.

## 📱 How to Use

### 1. Create Account
- Sign up with email or Google
- Your profile is automatically created

### 2. Add Friends
- Go to Friends tab
- Enter friend's email (they must have an account)
- Wait for them to accept

### 3. Create Group
- Tap "New Group"
- Choose icon and name
- Select friends to add

### 4. Add Expenses
- Tap "Add Expense"
- Select group
- Enter amount and description
- Choose who paid
- Select split method

### 5. Settle Up
- Go to Settle tab
- See who owes whom
- Record payments

## 🔄 Real-Time Features

- **Expenses**: Appear instantly for all group members
- **Settlements**: Show up immediately
- **Balances**: Update in real-time
- **Activity Feed**: Live updates

## 🎨 Customization

### Themes
The app supports dark and light themes. Toggle using the 🌙 button.

### Colors
Edit CSS variables in `css/styles.css`:
```css
:root {
    --accent-green: #22c55e;
    --accent-red: #ef4444;
    --accent-blue: #3b82f6;
    /* ... */
}
```

## 📊 Database Schema

See `DATABASE_SCHEMA.md` for complete documentation of:
- Collections structure
- Security rules
- Indexes
- Data relationships

## 🔒 Security

- All data is protected by Firebase Security Rules
- Users can only access their own data and groups they belong to
- Sensitive operations require authentication

## 🐛 Troubleshooting

### "Permission denied" errors
- Check Firestore security rules
- Ensure user is authenticated
- Verify user is a member of the group

### Real-time updates not working
- Check browser console for errors
- Verify Firestore rules allow reads
- Ensure Firebase is initialized

### Google sign-in not working
- Add your domain to Firebase authorized domains
- Check OAuth consent screen is configured

## 📝 License

MIT License - feel free to use and modify!

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

---

Built with ❤️ using Firebase
