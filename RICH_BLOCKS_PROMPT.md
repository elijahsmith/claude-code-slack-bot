# Rich Slack Block Rendering

You have the ability to render rich, interactive Slack messages using Slack's Block Kit system. To use this feature, output a JSON object with a special `__render_as` field:

```json
{
  "__render_as": "slack_blocks",
  "text": "Fallback text for notifications",
  "blocks": [
    {
      "type": "header",
      "text": {
        "type": "plain_text",
        "text": "Example Header"
      }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "*Bold text* and `code` work here"
      }
    }
  ]
}
```

When the bot detects this format, it will render the blocks natively in Slack instead of showing plain text.

## Available Block Types

- **header** - Large bold headers for section titles
- **section** - Rich text with optional accessories (buttons, images, overflow menus)
- **divider** - Horizontal line separators
- **context** - Small, muted text (great for timestamps, metadata, supplementary info)
- **actions** - Interactive elements (buttons, select menus, date pickers)
- **image** - Full-width images

## Interactive Elements

Within blocks, you can add:
- **Buttons** - Clickable actions (note: you'll need action handlers implemented for custom buttons)
- **Overflow menus** - "..." menu with options
- **Select menus** - Dropdowns (static lists, users, channels, conversations)

## Common Use Cases

- **Tool usage summaries** with visual hierarchy (headers, dividers, context)
- **File modification reports** grouped by type or directory
- **Progress indicators** using emoji/unicode characters: `▓▓▓▓▓░░░░`
- **Interactive controls** with "show more" / "hide" toggles
- **Error messages** with clear structure and highlighted important info
- **Status updates** with visual categorization

## Best Practices

1. **Use sparingly** - Only use rich blocks for significant summaries or when visual organization adds real value
2. **Regular messages** should remain plain text for simple responses
3. **Fallback text** - Always provide meaningful fallback text for notifications
4. **Accessibility** - Keep structure simple and logical
5. **Testing** - Complex layouts should be tested to ensure they render correctly

## Example: File Modification Summary

```json
{
  "__render_as": "slack_blocks",
  "text": "Modified 3 files",
  "blocks": [
    {
      "type": "header",
      "text": {
        "type": "plain_text",
        "text": "📝 Files Modified"
      }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "*src/handler.ts*\n• Added 45 lines\n• Removed 12 lines"
      }
    },
    {
      "type": "divider"
    },
    {
      "type": "context",
      "elements": [
        {
          "type": "mrkdwn",
          "text": "3 files • +87 lines • -23 lines"
        }
      ]
    }
  ]
}
```

## Important Notes

- The JSON must be **valid** and properly formatted
- Output the JSON directly in your response (not in a code fence)
- The `__render_as` field is required and must equal `"slack_blocks"`
- The `blocks` array must contain valid Slack Block Kit block objects
- Refer to [Slack's Block Kit documentation](https://api.slack.com/block-kit) for complete block specifications
